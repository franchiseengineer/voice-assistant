require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('Public')); 

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

wss.on('connection', (ws) => {
    let dgConnection = null; 
    let activeTemplate = []; 
    let slidingWindowTranscript = ""; 
    let heartbeat = null;
    let connectionStartTime = Date.now();

    const startHeartbeat = () => {
        if (heartbeat) return; // Don't start twice
        console.log("Brain Heartbeat Started.");
        
        heartbeat = setInterval(async () => {
            // DEBUG: Log status to Render console
            console.log(`Pulse Check: Transcript Length = ${slidingWindowTranscript.length}, Fields = ${activeTemplate.length}`);

            if (slidingWindowTranscript.trim().length < 10 || activeTemplate.length === 0) return;
            
            ws.send(JSON.stringify({ type: 'status', active: true }));

            try {
                const fieldInstructions = activeTemplate.map(f => `- ${f.name} (ID: ${f.id}): ${f.hint}`).join('\n');
                
                const ASSISTANT_PROMPT = `
                You are a surgical data extraction engine.
                TRANSCRIPT: "${slidingWindowTranscript}"
                EXTRACT THESE FIELDS:
                ${fieldInstructions}
                Return ONLY valid JSON. If not found, use "".
                `;

                const aiModel = genAI.getGenerativeModel({ 
                    model: "gemini-3-flash-preview",
                    generationConfig: { thinkingConfig: { thinkingLevel: "medium" } }
                }); 

                const result = await aiModel.generateContent(ASSISTANT_PROMPT);
                const text = result.response.text().replace(/```json|```/g, "").trim();
                
                console.log("AI SUCCESSFULLY EXTRACTED:", text);

                ws.send(JSON.stringify({ type: 'templateUpdate', data: JSON.parse(text) }));

            } catch (err) {
                console.error("GEMINI API ERROR:", err.message);
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

        dgConnection.on(LiveTranscriptionEvents.Open, () => console.log("Deepgram Open."));
        dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
            const transcript = data.channel.alternatives[0].transcript;
            if (transcript && data.is_final) {
                const labeledText = `[Speaker ${data.channel.alternatives[0].words[0]?.speaker ?? 0}] ${transcript}`;
                ws.send(JSON.stringify({ type: 'transcript', text: labeledText, isFinal: true }));
                slidingWindowTranscript += " " + labeledText;
            }
        });
    };

    ws.on('message', (message) => {
        const msgStr = message.toString();

        // 1. Check if it's a Text Command first (even if it's a Buffer)
        if (msgStr.startsWith('updateTemplate:')) {
            activeTemplate = JSON.parse(msgStr.replace('updateTemplate:', ''));
            console.log("SUCCESS: Template Updated. Fields count:", activeTemplate.length);
            return; // Stop here, don't send to Deepgram
        }

        // 2. If it's NOT a command and it's a Buffer, it must be Audio
        if (Buffer.isBuffer(message)) {
            if (!dgConnection) setupDeepgram();
            if (!heartbeat) startHeartbeat();
            
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
server.listen(PORT, () => console.log(`Gemini 3 Server active on port ${PORT}`));

