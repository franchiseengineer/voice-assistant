require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require('path');

if (!process.env.DEEPGRAM_API_KEY || !process.env.GEMINI_API_KEY) {
    console.error("FATAL ERROR: API keys are missing. Check your .env file.");
    process.exit(1);
}

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
        if (heartbeat) return;
        console.log("Brain Heartbeat Started.");
        
        heartbeat = setInterval(async () => {
            if (slidingWindowTranscript.trim().length < 10 || activeTemplate.length === 0) return;
            
            ws.send(JSON.stringify({ type: 'status', active: true }));

            try {
                const fieldInstructions = activeTemplate.map(f => `- ${f.name} (ID: ${f.id}): ${f.hint}`).join('\n');
                const ASSISTANT_PROMPT = `Extract valid JSON for these IDs: ${activeTemplate.map(f => f.id).join(', ')}. 
                Rules: Bullets only, factual, no speaker labels. Transcript: "${slidingWindowTranscript}"`;

                const aiModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" }); 

                // --- CORRECTED 2026 SYNTAX: thinkingLevel inside generationConfig ---
                const result = await aiModel.generateContent({
                    contents: [{ role: 'user', parts: [{ text: ASSISTANT_PROMPT }] }],
                    generationConfig: {
                        thinkingLevel: "MEDIUM", // Use uppercase for the 2026 thinking enum
                        temperature: 1.0,
                        maxOutputTokens: 2048
                    }
                });

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

        if (msgStr.startsWith('updateTemplate:')) {
            activeTemplate = JSON.parse(msgStr.replace('updateTemplate:', ''));
            console.log("SUCCESS: Template Updated. Fields count:", activeTemplate.length);
            return;
        }

        if (Buffer.isBuffer(message)) {
            const sessionAge = (Date.now() - connectionStartTime) / 60000;
            // Seamless 60-minute handoff logic remains active
            if (sessionAge > 55 || !dgConnection) {
                console.log(`Session Age: ${sessionAge.toFixed(1)}m. Restarting Deepgram...`);
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
server.listen(PORT, () => console.log(`Gemini 3 Server active on port ${PORT}`));
