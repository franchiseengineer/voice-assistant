require('dotenv').config();
const express = require('express');
const http = require('http'); // Added http module for server creation
const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const { GoogleGenAI } = require("@google/genai"); // UPDATED: New SDK
const path = require('path');

// Verify keys are loaded from .env at startup
if (!process.env.DEEPGRAM_API_KEY || !process.env.GEMINI_API_KEY) {
    console.error("FATAL ERROR: API keys are missing. Check your .env file.");
    process.exit(1);
}

const app = express();
const server = http.createServer(app); // Use http.createServer
const wss = new WebSocket.Server({ server });

// UPDATED: Serve files from 'Public' folder for Render compatibility
app.use(express.static('Public'));

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }); // UPDATED: New Client

wss.on('connection', (ws) => {
    let dgConnection = null; 
    let activeTemplate = []; 
    let slidingWindowTranscript = ""; 
    let knownState = {}; 
    let heartbeat = null;
    let connectionStartTime = Date.now();

    const checkSessionAge = () => {
        const ageInMinutes = (Date.now() - connectionStartTime) / 60000;
        if (ageInMinutes > 55) {
            console.log("Approaching 60-minute limit. Preparing seamless handoff...");
            // Logic to trigger a new setupDeepgram() without stopping the current one
            // Redirect incoming audio buffers to the NEW connection once ready
            connectionStartTime = Date.now(); // Reset timer for the new connection
        }
    };

    // Run this check every minute
    const ageMonitor = setInterval(checkSessionAge, 60000);

    const startHeartbeat = () => {
        heartbeat = setInterval(async () => {
            if (slidingWindowTranscript.trim().length < 20) return;
            ws.send(JSON.stringify({ type: 'status', active: true }));

            try {
                // --- YOUR EXACT PROMPT PRESERVED BELOW ---
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

                // UPDATED: New SDK Call Syntax
                const response = await aiClient.models.generateContent({
                    model: 'gemini-3-flash-preview',
                    config: {
                        responseMimeType: 'application/json',
                        generationConfig: {
                            thinkingConfig: {
                                thinkingLevel: "MEDIUM"
                            },
                            temperature: 1.0
                        }
                    },
                    contents: [{ role: 'user', parts: [{ text: ASSISTANT_PROMPT }] }]
                });

                const text = response.text();
                ws.send(JSON.stringify({ type: 'templateUpdate', data: JSON.parse(text) }));

            } catch (err) {
                console.error("AI Error:", err.message);
            } finally {
                ws.send(JSON.stringify({ type: 'status', active: false }));
            }
        }, 8000); 
    };

    const setupDeepgram = () => {
        // Updated syntax for Deepgram JS SDK v3
        dgConnection = deepgram.listen.live({
                model: "nova-2",
                language: "en-US",
                smart_format: true,
                diarize: true,
                filler_words: false,
                // MANDATORY for raw PCM from browser
                encoding: "linear16", 
                sample_rate: 16000,   
                interim_results: false
            });

        // Use LiveTranscriptionEvents to ensure the handshake is complete
        dgConnection.on(LiveTranscriptionEvents.Open, () => {
            console.log("Deepgram connected.");
            ws.send(JSON.stringify({ type: 'status', active: false }));
        });

        dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
            const transcript = data.channel.alternatives[0].transcript;
            // Only process final results to keep the sliding window clean
            if (transcript && data.is_final) {
                const speaker = data.channel.alternatives[0].words[0]?.speaker ?? 0;
                const labeledText = `[Speaker ${speaker}] ${transcript}`;
                
                ws.send(JSON.stringify({ type: 'transcript', text: labeledText, isFinal: true }));
                slidingWindowTranscript += " " + labeledText;
                
                if (slidingWindowTranscript.length > 8000) {
                    slidingWindowTranscript = slidingWindowTranscript.slice(-8000);
                }
            }
        });

        dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
            console.error("Deepgram SDK Error:", err);
        });

        dgConnection.on(LiveTranscriptionEvents.Close, () => {
            console.log("Deepgram connection closed.");
        });
    };

    ws.on('message', (message) => {
        const msgStr = message.toString();
        if (msgStr.startsWith('syncState:')) { knownState = JSON.parse(msgStr.split('syncState:')[1]); return; }
        if (msgStr.startsWith('updateTemplate:')) { activeTemplate = JSON.parse(msgStr.split('updateTemplate:')[1]); return; }
        if (msgStr === 'stop') {
            if (heartbeat) clearInterval(heartbeat);
            if (dgConnection) {
                dgConnection.finish();
                dgConnection = null;
            }
            return;
        }

        if (Buffer.isBuffer(message)) {
            // PROACTIVE HANDOFF: Check if connection is > 55 mins old 
            const sessionDuration = (Date.now() - connectionStartTime) / 60000;
            if (sessionDuration > 55 || !dgConnection) {
                console.log(`Session Age: ${sessionDuration.toFixed(1)}m. Initializing handoff...`);
                setupDeepgram();
                if (!heartbeat) startHeartbeat();
            }

            if (dgConnection && dgConnection.getReadyState() === 1 && message.length > 0) {
                dgConnection.send(message);
            }
        }
    });

    ws.on('close', () => { 
        if (heartbeat) clearInterval(heartbeat); 
        if (dgConnection) dgConnection.finish(); 
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
