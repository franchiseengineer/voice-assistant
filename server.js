require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const { GoogleGenAI } = require("@google/genai"); // Modern SDK

if (!process.env.DEEPGRAM_API_KEY || !process.env.GEMINI_API_KEY) {
    console.error("FATAL ERROR: API keys are missing. Check your .env file.");
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('Public')); 

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

wss.on('connection', (ws) => {
    let dgConnection = null; 
    let activeTemplate = []; 
    // [NEW] Track client state to prevent overwriting
    let currentClientState = { fields: [], userNotes: "" };
    let slidingWindowTranscript = ""; 
    let heartbeat = null;
    let connectionStartTime = Date.now();

    const startHeartbeat = () => {
        if (heartbeat) return;
        console.log("Gemini 3 Heartbeat Started.");
        
        heartbeat = setInterval(async () => {
            // FIX: If activeTemplate is empty, try to populate it from the client state
            // This ensures the loop doesn't abort if the client sent 'contextUpdate' instead of 'updateTemplate'
            if (activeTemplate.length === 0 && currentClientState.fields.length > 0) {
                 activeTemplate = currentClientState.fields;
            }

            if (slidingWindowTranscript.trim().length < 10 || activeTemplate.length === 0) return;
            
            ws.send(JSON.stringify({ type: 'status', active: true }));

            try {
                // [NEW] Build Context Block. 
                // This forces Gemini to see existing data so it merges instead of overwrites.
                const CONTEXT_BLOCK = `
                ### CURRENT KNOWLEDGE STATE (Context)
                Use this to merge new facts. If the new transcript is silent on a topic, PRESERVE these values:
                User Manual Notes: "${currentClientState.userNotes || ''}"
                Current Field Values: ${JSON.stringify(currentClientState.fields.map(f => ({ id: f.id, val: f.currentValue })))}
                
                ### INSTRUCTIONS`;

                // --- YOUR EXACT PROMPT (UNTOUCHED) ---
                const ASSISTANT_PROMPT = `
                You are a professional assistant creating a clean, scannable knowledge base. 
                Your goal is to produce a clean, factual report based on the provided transcript.

                STRICT PERSONA & CONTENT RULES:
                1. NO SPEAKER LABELS: Do not use phrases like "Speaker 1 says" or "According to Speaker 0." State information as objective facts.
                2. MULTIPLE PERSPECTIVES: If viewpoints differ, describe the range of ideas neutrally (e.g., "Perspectives on wealth acquisition vary...").
                3. FACTUAL RECORD: Organize the transcript into factual, bulleted notes for each field.
                4. SURGICAL EXTRACTION: If a field is "Name," look ONLY for a person's actual name. If "Date," look ONLY for a specific calendar date. 
                5. NEGATIVE CONSTRAINT: If the transcript does not contain the specific information for a field, leave that field value as an empty string "". Do NOT summarize unrelated themes into these fields.

                STRICT FORMATTING RULES:
                1. BULLETED NOTES ONLY: Every point must be a separate bullet starting with "* ".
                2. NEW LINES: Every single bullet point MUST be on its own new line. No paragraphs or blocks of text.
                3. NO FILLER: Redact all "ums," "ahs," and conversational repetition.

                TRANSCRIPT: "${slidingWindowTranscript}"

                OUTPUT: Return ONLY a flat JSON object where keys match these IDs: ${activeTemplate.map(f => f.id).join(', ')}.
                `;
                // -----------------------------------------

                // [UPDATED] Prepend Context, but keep YOUR Model & Config
                const response = await aiClient.models.generateContent({
                    model: 'gemini-3.0-flash-exp', // Updated to 2026 standard
                    config: {
                        responseMimeType: 'application/json',
                        generationConfig: {
                            thinkingConfig: {
                                thinkingLevel: "MEDIUM" 
                            }, 
                            temperature: 1.0
                        }
                    },
                    contents: [{ role: 'user', parts: [{ text: CONTEXT_BLOCK + "\n" + ASSISTANT_PROMPT }] }]
                });

                // --- CRITICAL FIX: Extract text manually ---
                let text = "";
                if (response.candidates && response.candidates[0].content.parts[0].text) {
                     text = response.candidates[0].content.parts[0].text;
                }
                // -----------------------------------------

                console.log("Gemini 3 Success"); 
                ws.send(JSON.stringify({ type: 'templateUpdate', data: JSON.parse(text) }));

            } catch (err) {
                console.error("Gemini 3 Error:", err.message);
            } finally {
                ws.send(JSON.stringify({ type: 'status', active: false }));
            }
        }, 10000); 
    };

    const setupDeepgram = () => {
        dgConnection = deepgram.listen.live({
            model: "nova-2", language: "en-US", smart_format: true, diarize: true,
            encoding: "linear16", sample_rate: 16000, interim_results: false
        });

        dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
            const transcript = data.channel.alternatives[0].transcript;
            if (transcript && data.is_final) {
                const labeledText = `[Speaker ${data.channel.alternatives[0].words[0]?.speaker ?? 0}] ${transcript}`;
                ws.send(JSON.stringify({ type: 'transcript', text: labeledText, isFinal: true }));
                slidingWindowTranscript += " " + labeledText;
                
                // [NEW] Safety cap 
                if(slidingWindowTranscript.length > 50000) slidingWindowTranscript = slidingWindowTranscript.slice(-40000);
            }
        });
    };

    // [FIX] Updated signature to accept isBinary flag
    ws.on('message', (message, isBinary) => {
        // [NEW] Handle JSON Context Updates safely
        // In 'ws' v8+, text messages come as Buffers but with isBinary=false
        if (!isBinary) {
            try {
                const msgStr = message.toString();
                
                // 1. Template Update (Legacy/Startup)
                if (msgStr.startsWith('updateTemplate:')) {
                    activeTemplate = JSON.parse(msgStr.replace('updateTemplate:', ''));
                    // Initialize state if empty
                    if(currentClientState.fields.length === 0) {
                         currentClientState.fields = activeTemplate.map(f => ({...f, currentValue: ''}));
                    }
                    console.log("SUCCESS: Template Updated.");
                    return;
                }

                // 2. Context Update (Real-Time State Sync)
                const jsonMsg = JSON.parse(msgStr);
                if (jsonMsg.type === 'contextUpdate') {
                    currentClientState.fields = jsonMsg.fields;
                    currentClientState.userNotes = jsonMsg.userNotes;

                    // FIX: Also sync activeTemplate so the heartbeat loop knows we have a valid template
                    if (activeTemplate.length === 0 && jsonMsg.fields.length > 0) {
                        activeTemplate = jsonMsg.fields;
                    }
                    return;
                }
            } catch(e) { /* ignore non-json text */ }
            return;
        }

        if (isBinary) {
            const sessionAge = (Date.now() - connectionStartTime) / 60000;
            if (sessionAge > 55 || !dgConnection) {
                if(dgConnection) dgConnection.finish();
                setupDeepgram();
                connectionStartTime = Date.now();
                if (!heartbeat) startHeartbeat();
            }
            if (dgConnection && dgConnection.getReadyState() === 1) {
                dgConnection.send(message);
            }
        }
    });

    ws.on('close', () => {
        clearInterval(heartbeat);
        if (dgConnection) dgConnection.finish();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Gemini 3 Server (GenAI) active on port ${PORT}`));
