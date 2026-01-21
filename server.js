require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require('path');

// Verify keys
if (!process.env.DEEPGRAM_API_KEY || !process.env.GEMINI_API_KEY) {
    console.error("FATAL ERROR: API keys are missing. Check your .env file.");
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- CLOUD FIX: Serve the 'public' folder ---
app.use(express.static('public')); 
// -------------------------------------------

// Initialize Clients
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

wss.on('connection', (ws) => {
    let dgConnection = null; 
    let activeTemplate = []; 
    let slidingWindowTranscript = ""; 
    let heartbeat = null;
    
    // --- RESTORED: SESSION TIMER ---
    let connectionStartTime = Date.now();

    // --- 1. GEMINI 3 HEARTBEAT (The Brain) ---
    const startHeartbeat = () => {
        heartbeat = setInterval(async () => {
            if (slidingWindowTranscript.trim().length < 20 || activeTemplate.length === 0) return;
            
            ws.send(JSON.stringify({ type: 'status', active: true }));

            try {
                const fieldInstructions = activeTemplate.map(f => `- ${f.name} (ID: ${f.id}): ${f.hint}`).join('\n');
                
                const ASSISTANT_PROMPT = `
                You are a professional assistant creating a clean, scannable knowledge base. 
                TRANSCRIPT: "${slidingWindowTranscript}"

                STRICT PERSONA & CONTENT RULES:
                1. NO SPEAKER LABELS. State information as objective facts.
                2. FACTUAL RECORD: Organize the transcript into factual, bulleted notes for each field.
                3. SURGICAL EXTRACTION: If a field is "Name," look ONLY for a person's actual name.
                4. NEGATIVE CONSTRAINT: If the transcript does not contain the specific information, leave that field value as "".

                OUTPUT: Return ONLY a flat JSON object where keys match these IDs: ${activeTemplate.map(f => f.id).join(', ')}.
                `;

                // --- RESTORED: GEMINI 3 MODEL & CONFIG ---
                const aiModel = genAI.getGenerativeModel({ 
                    model: "gemini-3-flash-preview",
                    generationConfig: {
                        thinkingConfig: {
                            thinkingLevel: "medium" 
                        }
                    }
                }); 

                const result = await aiModel.generateContent(ASSISTANT_PROMPT);
                const response = await result.response;
                const text = response.text().replace(/```json|```/g, "").trim();

                ws.send(JSON.stringify({ 
                    type: 'templateUpdate', 
                    data: JSON.parse(text)
                }));

            } catch (err) {
                console.error("Gemini 3 Error:", err.message);
            } finally {
                ws.send(JSON.stringify({ type: 'status', active: false }));
            }
        }, 10000); // 10 seconds
    };

    // --- 2. DEEPGRAM SETUP (The Ear) ---
    const setupDeepgram = () => {
        dgConnection = deepgram.listen.live({
            model: "nova-2",
            language: "en-US",
            smart_format: true,
            diarize: true,
            encoding: "linear16", 
            sample_rate: 16000, 
            interim_results: false
        });

        dgConnection.on(LiveTranscriptionEvents.Open, () => {
            console.log("Deepgram connected (New Session).");
            ws.send(JSON.stringify({ type: 'status', active: false }));
        });

        dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
            const transcript = data.channel.alternatives[0].transcript;
            if (transcript && data.is_final) {
                const speaker = data.channel.alternatives[0].words[0]?.speaker ?? 0;
                const labeledText = `[Speaker ${speaker}] ${transcript}`;
                
                ws.send(JSON.stringify({ type: 'transcript', text: labeledText, isFinal: true }));
                slidingWindowTranscript += " " + labeledText;
                
                if (slidingWindowTranscript.length > 20000) {
                    slidingWindowTranscript = slidingWindowTranscript.slice(-20000);
                }
            }
        });

        dgConnection.on(LiveTranscriptionEvents.Error, (err) => console.error("Deepgram Error:", err));
        dgConnection.on(LiveTranscriptionEvents.Close, () => console.log("Deepgram closed."));
    };

    // --- 3. MESSAGE HANDLING & HANDOFF ---
    ws.on('message', (message) => {
        if (Buffer.isBuffer(message)) {
            // --- RESTORED: THE 60-MINUTE HANDOFF LOGIC ---
            const sessionDuration = (Date.now() - connectionStartTime) / 60000;
            
            // If session is > 55 minutes OR Deepgram isn't running, restart it seamlessly
            if (sessionDuration > 55 || !dgConnection) {
                console.log(`Session Age: ${sessionDuration.toFixed(1)}m. Initializing Handoff/Restart...`);
                
                // Clean up old connection if it exists
                if(dgConnection) dgConnection.finish();
                
                // Start fresh
                setupDeepgram();
                
                // Reset the timer
                connectionStartTime = Date.now();

                // Ensure heartbeat is running
                if (!heartbeat) startHeartbeat();
            }
            // ---------------------------------------------

            if (dgConnection && dgConnection.getReadyState() === 1) {
                dgConnection.send(message);
            }
        } else {
            // Text Commands
            const msgStr = message.toString();
            try {
                if (msgStr.startsWith('updateTemplate:')) {
                    activeTemplate = JSON.parse(msgStr.replace('updateTemplate:', ''));
                } else if (msgStr === 'stop') {
                    if (heartbeat) clearInterval(heartbeat);
                    if (dgConnection) { dgConnection.finish(); dgConnection = null; }
                }
            } catch (e) { console.error("Command Error:", e); }
        }
    });

    ws.on('close', () => {
        if (heartbeat) clearInterval(heartbeat);
        if (dgConnection) dgConnection.finish();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Gemini 3 Server active on port ${PORT}`));
