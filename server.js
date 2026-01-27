require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const { GoogleGenAI } = require("@google/genai");

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
    console.log("========================================");
    console.log("NEW CLIENT CONNECTED");
    console.log("========================================");
    
    let dgConnection = null; 
    let activeTemplate = []; 
    let currentClientState = { fields: [], userNotes: "" };
    let slidingWindowTranscript = ""; 
    let heartbeat = null;
    let connectionStartTime = Date.now();
    let isProcessing = false;
    let heartbeatCount = 0;

    const startHeartbeat = () => {
        if (heartbeat) return;
        console.log("✓ HEARTBEAT STARTED");
        
        heartbeat = setInterval(async () => {
            heartbeatCount++;
            console.log(`\n========== HEARTBEAT #${heartbeatCount} ==========`);
            console.log(`Time: ${new Date().toLocaleTimeString()}`);
            
            // Detailed diagnostic output
            console.log(`Template Status: ${activeTemplate.length > 0 ? `✓ ${activeTemplate.length} fields` : '✗ EMPTY'}`);
            console.log(`Transcript Length: ${slidingWindowTranscript.length} chars`);
            console.log(`Client State Fields: ${currentClientState.fields.length}`);
            console.log(`Is Processing: ${isProcessing}`);
            
            // Guard 1: Template check
            if (activeTemplate.length === 0) {
                console.log("⚠ BLOCKED: No template data");
                if (currentClientState.fields.length > 0) {
                    console.log("   Attempting recovery from client state...");
                    activeTemplate = currentClientState.fields;
                    console.log(`   ✓ Recovered ${activeTemplate.length} fields`);
                } else {
                    console.log("   ✗ Client state also empty. Waiting...");
                    return;
                }
            }
            
            // Guard 2: Transcript check
            if (slidingWindowTranscript.trim().length < 10) {
                console.log("⚠ BLOCKED: Transcript too short");
                console.log(`   Current: "${slidingWindowTranscript.substring(0, 50)}"`);
                return;
            }
            
            // Guard 3: Processing lock
            if (isProcessing) {
                console.log("⚠ BLOCKED: Already processing");
                return;
            }
            
            console.log("✓ ALL GUARDS PASSED - STARTING AI CALL");
            isProcessing = true;
            ws.send(JSON.stringify({ type: 'status', active: true }));

            try {
                console.log("\n--- Building AI Request ---");
                
                // Show what we're sending to the AI
                console.log("Active Template IDs:", activeTemplate.map(f => f.id).join(', '));
                console.log("Transcript preview:", slidingWindowTranscript.substring(0, 200) + "...");
                
                // Build current state
                const currentData = {};
                currentClientState.fields.forEach(f => {
                    currentData[f.id] = f.currentValue || "(empty)";
                });

                const PROMPT = `You are extracting information from a conversation transcript into structured fields.

TARGET FIELDS:
${activeTemplate.map(f => `- ID: "${f.id}" | Name: "${f.name}" | Hint: ${f.hint || 'Extract relevant info'}`).join('\n')}

CURRENT DATA STATE:
${JSON.stringify(currentData, null, 2)}

NEW TRANSCRIPT:
"${slidingWindowTranscript}"

INSTRUCTIONS:
1. Extract ONLY information that matches each field's hint/purpose
2. For narrative fields (like Summary, Notes), add bullet points starting with "* "
3. For single-value fields (like Name, Date), provide the specific value
4. If no new information for a field, output empty string ""

OUTPUT FORMAT (JSON):
Return a flat JSON object where keys are field IDs and values are the extracted content.
Example: {"name": "John Doe", "summary": "* Discussed franchise opportunities\n* Interested in fitness industry", "date": "January 27, 2026"}

If no information matches any fields, return empty object: {}
`;

                console.log("\n--- Calling Gemini API ---");
                console.log("Prompt length:", PROMPT.length, "characters");
                
                const response = await aiClient.models.generateContent({
                    model: 'gemini-2.0-flash-exp',
                    config: {
                        responseMimeType: 'application/json',
                        generationConfig: { temperature: 0.2 }
                    },
                    contents: [{ role: 'user', parts: [{ text: PROMPT }] }]
                });

                console.log("✓ API Response Received");
                
                // Detailed response inspection
                console.log("\n--- Parsing Response ---");
                console.log("Response structure:", {
                    hasCandidates: !!response.candidates,
                    candidatesLength: response.candidates?.length,
                    hasContent: !!response.candidates?.[0]?.content,
                    hasParts: !!response.candidates?.[0]?.content?.parts,
                    partsLength: response.candidates?.[0]?.content?.parts?.length
                });

                let extractedData = null;
                if (response?.candidates?.[0]?.content?.parts?.[0]?.text) {
                    const rawText = response.candidates[0].content.parts[0].text;
                    console.log("Raw AI response:", rawText.substring(0, 500));
                    
                    try {
                        extractedData = JSON.parse(rawText);
                        console.log("✓ JSON parsed successfully");
                    } catch (parseErr) {
                        console.log("⚠ Direct parse failed, trying regex...");
                        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            extractedData = JSON.parse(jsonMatch[0]);
                            console.log("✓ JSON extracted via regex");
                        } else {
                            console.error("✗ No JSON found in response");
                            console.error("Raw text was:", rawText);
                        }
                    }
                } else {
                    console.error("✗ Response missing expected structure");
                    console.error("Full response:", JSON.stringify(response, null, 2));
                }

                if (!extractedData) {
                    console.log("✗ FAILED: Could not extract data from AI response");
                    return;
                }

                console.log("\n--- Processing Extracted Data ---");
                console.log("Fields in response:", Object.keys(extractedData).join(', '));
                
                if (Object.keys(extractedData).length === 0) {
                    console.log("ℹ No data extracted");
                    return;
                }

                // Apply updates with deduplication
                let changesMade = false;
                
                Object.keys(extractedData).forEach(fieldId => {
                    const newValue = extractedData[fieldId];
                    
                    if (!newValue || newValue.trim() === "" || newValue === "(empty)") {
                        console.log(`  ⏭ Skipping "${fieldId}" - empty value`);
                        return;
                    }
                    
                    const field = currentClientState.fields.find(f => f.id === fieldId);
                    
                    if (!field) {
                        console.log(`  ⚠ Field "${fieldId}" not found in client state`);
                        console.log(`     Available fields: ${currentClientState.fields.map(f => f.id).join(', ')}`);
                        return;
                    }

                    const oldValue = field.currentValue || "";
                    const cleanNewValue = newValue.trim();
                    
                    // Smart merge logic
                    let finalValue = oldValue;
                    
                    if (oldValue === "") {
                        // First time data - just set it
                        finalValue = cleanNewValue;
                        console.log(`  ✓ "${fieldId}": Initial value set`);
                        console.log(`     Value: ${cleanNewValue.substring(0, 100)}...`);
                    } else {
                        // Check if it's a duplicate
                        const oldLower = oldValue.toLowerCase();
                        const newLower = cleanNewValue.toLowerCase();
                        
                        if (oldLower.includes(newLower.replace(/^\*\s*/, ''))) {
                            console.log(`  ⏭ "${fieldId}": Duplicate detected, skipping`);
                            return;
                        }
                        
                        // Append new content
                        finalValue = oldValue + "\n" + cleanNewValue;
                        console.log(`  ✓ "${fieldId}": Appended new content`);
                        console.log(`     Added: ${cleanNewValue.substring(0, 100)}...`);
                    }

                    if (finalValue !== oldValue) {
                        field.currentValue = finalValue;
                        changesMade = true;
                    }
                });

                if (changesMade) {
                    console.log("\n--- Sending Updates to Client ---");
                    const flatUpdate = currentClientState.fields.reduce((acc, f) => {
                        acc[f.id] = f.currentValue;
                        return acc;
                    }, {});
                    
                    console.log("Sending update for fields:", Object.keys(flatUpdate).filter(k => flatUpdate[k]).join(', '));
                    ws.send(JSON.stringify({ type: 'templateUpdate', data: flatUpdate }));
                    console.log("✓ Updates sent successfully");
                } else {
                    console.log("\nℹ No changes made after deduplication");
                }

            } catch (err) {
                console.error("\n❌ ERROR CAUGHT:");
                console.error("Message:", err.message);
                console.error("Stack:", err.stack);
                ws.send(JSON.stringify({ type: 'error', message: err.message }));
            } finally {
                isProcessing = false;
                ws.send(JSON.stringify({ type: 'status', active: false }));
                console.log("\n========== HEARTBEAT END ==========\n");
            }
        }, 10000); 
    };

    const setupDeepgram = () => {
        console.log("Setting up Deepgram connection...");
        dgConnection = deepgram.listen.live({
            model: "nova-2", 
            language: "en-US", 
            smart_format: true, 
            diarize: true,
            encoding: "linear16", 
            sample_rate: 16000, 
            interim_results: false
        });

        dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
            const transcript = data.channel.alternatives[0].transcript;
            if (transcript && data.is_final) {
                const labeledText = `[Speaker ${data.channel.alternatives[0].words[0]?.speaker ?? 0}] ${transcript}`;
                console.log("📝 Transcript:", labeledText);
                ws.send(JSON.stringify({ type: 'transcript', text: labeledText, isFinal: true }));
                slidingWindowTranscript += " " + labeledText;
                
                if (slidingWindowTranscript.length > 50000) {
                    console.log("⚠ Trimming transcript (exceeded 50k chars)");
                    slidingWindowTranscript = slidingWindowTranscript.slice(-40000);
                }
            }
        });

        dgConnection.on('error', (err) => {
            console.error("❌ Deepgram Error:", err);
        });
        
        console.log("✓ Deepgram setup complete");
    };

    ws.on('message', (message, isBinary) => {
        const isMsgBinary = isBinary || (Buffer.isBuffer(message) && (message.length > 0 && message[0] !== 123)); 
        
        if (!isMsgBinary) {
            try {
                const msgStr = message.toString();
                
                if (msgStr.startsWith('updateTemplate:')) {
                    activeTemplate = JSON.parse(msgStr.replace('updateTemplate:', ''));
                    if (currentClientState.fields.length === 0) {
                        currentClientState.fields = activeTemplate.map(f => ({
                            ...f, 
                            currentValue: ''
                        }));
                    }
                    console.log(`✓ Template initialized via legacy method: ${activeTemplate.length} fields`);
                    console.log("   Fields:", activeTemplate.map(f => f.id).join(', '));
                    return;
                }

                const jsonMsg = JSON.parse(msgStr);
                if (jsonMsg.type === 'contextUpdate') {
                    console.log("\n--- Context Update Received ---");
                    console.log("Fields count:", jsonMsg.fields?.length || 0);
                    console.log("User notes present:", !!jsonMsg.userNotes);
                    
                    currentClientState.fields = jsonMsg.fields;
                    currentClientState.userNotes = jsonMsg.userNotes;

                    if (jsonMsg.fields && jsonMsg.fields.length > 0) {
                        activeTemplate = jsonMsg.fields;
                        console.log(`✓ Active template synced: ${activeTemplate.length} fields`);
                        console.log("   Field IDs:", activeTemplate.map(f => f.id).join(', '));
                        console.log("   Field Values:");
                        activeTemplate.forEach(f => {
                            const val = f.currentValue || '';
                            console.log(`     ${f.id}: "${val.substring(0, 50)}${val.length > 50 ? '...' : ''}"`);
                        });
                    }
                    return;
                }
            } catch(e) { 
                // Silently ignore non-JSON
            }
            return;
        }

        if (isMsgBinary) {
            const sessionAge = (Date.now() - connectionStartTime) / 60000;
            
            if (sessionAge > 55 || !dgConnection) {
                if (dgConnection) {
                    console.log("🔄 Refreshing Deepgram connection (55min timeout)");
                    dgConnection.finish();
                }
                setupDeepgram();
                connectionStartTime = Date.now();
                
                if (!heartbeat) {
                    console.log("Starting heartbeat (triggered by first audio)");
                    startHeartbeat();
                }
            }
            
            if (dgConnection && dgConnection.getReadyState() === 1) {
                dgConnection.send(message);
            }
        }
    });

    ws.on('close', () => {
        clearInterval(heartbeat);
        if (dgConnection) dgConnection.finish();
        console.log("✓ Client disconnected");
    });

    ws.on('error', (err) => {
        console.error("❌ WebSocket Error:", err.message);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ DIAGNOSTIC SERVER active on port ${PORT}`));
