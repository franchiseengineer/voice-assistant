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

// --- ENHANCED SCHEMA DEFINITION ---
// Using inline type definitions instead of SchemaType
const UPDATE_SCHEMA = {
  type: "object",
  properties: {
    updates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fieldId: { 
            type: "string", 
            description: "The exact ID of the field to update (must match template IDs)." 
          },
          action: { 
            type: "string", 
            enum: ["APPEND", "REPLACE", "SKIP"], 
            description: "APPEND: Add new bullet point to existing notes. REPLACE: Overwrite entire field (use only for corrections or single-value fields like Name/Date). SKIP: No update needed for this field." 
          },
          value: { 
            type: "string", 
            description: "The new content. For APPEND, start with '* '. For REPLACE, provide complete new value. For SKIP, leave empty." 
          },
          reason: {
            type: "string",
            description: "Brief explanation of why this update is needed (helps with debugging)."
          }
        },
        required: ["fieldId", "action", "value"]
      }
    }
  },
  required: ["updates"]
};

wss.on('connection', (ws) => {
    let dgConnection = null; 
    let activeTemplate = []; 
    let currentClientState = { fields: [], userNotes: "" };
    let slidingWindowTranscript = ""; 
    let processedTranscriptLength = 0; // Track what we've already analyzed
    let heartbeat = null;
    let connectionStartTime = Date.now();
    let isProcessing = false;

    const startHeartbeat = () => {
        if (heartbeat) return;
        console.log("✓ Heartbeat Started (Delta Pattern v2)");
        
        heartbeat = setInterval(async () => {
            // Guard Clauses
            if (activeTemplate.length === 0) {
                // Try to recover from client state
                if (currentClientState.fields.length > 0) {
                    activeTemplate = currentClientState.fields;
                    console.log(`✓ Recovered template from client state: ${activeTemplate.length} fields`);
                } else {
                    console.log("⏸ Waiting for template data...");
                    return;
                }
            }
            
            // Only process NEW transcript content
            const newContent = slidingWindowTranscript.slice(processedTranscriptLength);
            if (newContent.trim().length < 10) return;
            
            if (isProcessing) {
                console.log("⏸ Already processing, skipping this cycle");
                return;
            }
            
            isProcessing = true;
            ws.send(JSON.stringify({ type: 'status', active: true }));

            // Safety timeout: Auto-unlock after 15 seconds if processing gets stuck
            const processingTimeout = setTimeout(() => {
                if (isProcessing) {
                    console.error("⚠️ Processing timeout - forcing unlock");
                    isProcessing = false;
                    ws.send(JSON.stringify({ type: 'status', active: false }));
                }
            }, 15000);

            try {
                // [RESTORED] Your Original Prompt Logic + Delta Instructions
                const SYSTEM_INSTRUCTION = `
You are a professional assistant creating a clean, scannable knowledge base.
Your goal is to analyze the NEW transcript segment and produce a clean, factual report by generating specific UPDATES for the database.

### TARGET FIELDS
${activeTemplate.map(f => `- ID: "${f.id}" | Name: "${f.name}" | Hint: ${f.hint}`).join('\n')}

### STRICT PERSONA & CONTENT RULES
1. **NO SPEAKER LABELS**: Do not use phrases like "Speaker 1 says" or "According to Speaker 0." State information as objective facts.
2. **MULTIPLE PERSPECTIVES**: If viewpoints differ, describe the range of ideas neutrally (e.g., "Perspectives on wealth acquisition vary...").
3. **FACTUAL RECORD**: Organize the transcript into factual, bulleted notes for each field.
4. **SURGICAL EXTRACTION**: If a field is "Name," look ONLY for a person's actual name. If "Date," look ONLY for a specific calendar date.
5. **NEGATIVE CONSTRAINT**: Do NOT summarize unrelated themes into these fields. Use action "SKIP" if the transcript does not contain specific information for a field.
6. **NO FILLER**: Redact all "ums," "ahs," and conversational repetition.

### MERGE INTELLIGENCE & FORMATTING
1. **BULLETED NOTES ONLY**: For narrative fields (APPEND action), every point must be a separate bullet starting with "* ".
2. **Use APPEND** for: lists, summaries, multi-point discussions.
3. **Use REPLACE** only for: corrections, single-value fields (names, dates, specific numbers).
4. **Use SKIP** when: no new information, or information doesn't match any field.

### DEDUPLICATION STRATEGY
Before adding a bullet point, check if the SAME IDEA (not exact words) is already present in the Current Database State.
If discussing the same topic with more detail, APPEND the new detail.
If stating the same fact, use SKIP.
`;

                // Build the payload with current state
                const currentStateSnapshot = currentClientState.fields.reduce((acc, f) => {
                    acc[f.id] = {
                        name: f.name,
                        currentValue: f.currentValue || "(empty)",
                        charCount: (f.currentValue || "").length
                    };
                    return acc;
                }, {});

                const USER_PAYLOAD = `
### CURRENT DATABASE STATE
${JSON.stringify(currentStateSnapshot, null, 2)}

### USER MANUAL NOTES (DO NOT MODIFY)
${currentClientState.userNotes || "(none)"}

### NEW TRANSCRIPT SEGMENT (Only process this)
"${newContent}"

### OUTPUT
Generate the JSON update list. Be conservative - when in doubt, SKIP rather than duplicate.
`;

                console.log(`🔄 Analyzing ${newContent.length} chars of new transcript...`);

                const response = await aiClient.models.generateContent({
                    model: 'gemini-3-flash-preview', 
                    config: {
                        responseMimeType: 'application/json',
                        responseSchema: UPDATE_SCHEMA,
                        generationConfig: { 
                            temperature: 0.2, // Very low for consistency
                            topP: 0.8,
                            topK: 20
                        },
                        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] }
                    },
                    contents: [{ role: 'user', parts: [{ text: USER_PAYLOAD }] }]
                });

                // Robust JSON extraction
                let result = null;
                if (response?.candidates?.[0]?.content?.parts?.[0]?.text) {
                    const rawText = response.candidates[0].content.parts[0].text;
                    
                    // Try direct parse first
                    try {
                        result = JSON.parse(rawText);
                    } catch {
                        // Fallback: extract JSON from markdown or mixed content
                        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            result = JSON.parse(jsonMatch[0]);
                        }
                    }
                }

                if (!result || !result.updates) {
                    console.log("⚠ No valid updates returned");
                    processedTranscriptLength = slidingWindowTranscript.length;
                    return;
                }

                // Apply Delta Updates with Enhanced Deduplication
                const updates = result.updates.filter(u => u.action !== "SKIP");
                
                if (updates.length === 0) {
                    console.log("✓ No changes needed (all updates were SKIP)");
                    processedTranscriptLength = slidingWindowTranscript.length;
                    return;
                }

                console.log(`📝 Processing ${updates.length} updates:`);
                let changesMade = false;
                
                updates.forEach((update, idx) => {
                    const field = currentClientState.fields.find(f => f.id === update.fieldId);
                    
                    if (!field) {
                        console.log(`  ${idx + 1}. ⚠ Field "${update.fieldId}" not found - skipping`);
                        return;
                    }

                    const oldValue = field.currentValue || "";
                    let newValue = oldValue;

                    if (update.action === "APPEND") {
                        // Enhanced deduplication: Check for semantic duplicates
                        const cleanValue = update.value.trim();
                        const cleanExisting = oldValue.toLowerCase().trim();
                        const cleanNew = cleanValue.toLowerCase().trim();
                        
                        // Simple duplicate check: if exact phrase exists, skip
                        if (cleanExisting.includes(cleanNew.replace(/^\*\s*/, ''))) {
                            console.log(`  ${idx + 1}. ⏭ Duplicate detected in "${field.name}" - skipping`);
                            return;
                        }

                        // Append with proper formatting
                        newValue = oldValue 
                            ? oldValue + "\n" + cleanValue 
                            : cleanValue;
                        
                        console.log(`  ${idx + 1}. ➕ APPEND to "${field.name}": ${cleanValue.substring(0, 50)}...`);
                        
                    } else if (update.action === "REPLACE") {
                        // Only replace if actually different
                        if (oldValue === update.value.trim()) {
                            console.log(`  ${idx + 1}. ⏭ No change needed in "${field.name}"`);
                            return;
                        }
                        
                        newValue = update.value.trim();
                        console.log(`  ${idx + 1}. 🔄 REPLACE "${field.name}": ${oldValue.substring(0, 30)}... → ${newValue.substring(0, 30)}...`);
                    }

                    if (newValue !== oldValue) {
                        field.currentValue = newValue;
                        changesMade = true;
                    }
                });

                // Sync to client if changes were made
                if (changesMade) {
                    const flatUpdate = currentClientState.fields.reduce((acc, f) => {
                        acc[f.id] = f.currentValue;
                        return acc;
                    }, {});
                    
                    ws.send(JSON.stringify({ type: 'templateUpdate', data: flatUpdate }));
                    console.log("✓ Updates sent to client");
                } else {
                    console.log("✓ No actual changes after deduplication");
                }

                // Mark this content as processed
                processedTranscriptLength = slidingWindowTranscript.length;

            } catch (err) {
                console.error("❌ Gemini Error:", err.message);
                if (err.stack) console.error(err.stack);
                ws.send(JSON.stringify({ type: 'error', message: err.message }));
            } finally {
                clearTimeout(processingTimeout);
                isProcessing = false;
                ws.send(JSON.stringify({ type: 'status', active: false }));
            }
        }, 10000); 
    };

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

        dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
            const transcript = data.channel.alternatives[0].transcript;
            if (transcript && data.is_final) {
                const labeledText = `[Speaker ${data.channel.alternatives[0].words[0]?.speaker ?? 0}] ${transcript}`;
                ws.send(JSON.stringify({ type: 'transcript', text: labeledText, isFinal: true }));
                slidingWindowTranscript += " " + labeledText;
                
                // Safety cap with warning
                if (slidingWindowTranscript.length > 50000) {
                    console.log("⚠ Transcript exceeding 50k chars, trimming oldest content");
                    slidingWindowTranscript = slidingWindowTranscript.slice(-40000);
                    // Adjust processed pointer to match
                    if (processedTranscriptLength > 40000) {
                        processedTranscriptLength = 40000;
                    }
                }
            }
        });

        dgConnection.on('error', (err) => {
            console.error("❌ Deepgram Error:", err);
        });
    };

    ws.on('message', (message, isBinary) => {
        // Robust binary detection
        const isMsgBinary = isBinary || (Buffer.isBuffer(message) && (message.length > 0 && message[0] !== 123)); 
        
        if (!isMsgBinary) {
            try {
                const msgStr = message.toString();
                
                // Legacy template initialization
                if (msgStr.startsWith('updateTemplate:')) {
                    activeTemplate = JSON.parse(msgStr.replace('updateTemplate:', ''));
                    if (currentClientState.fields.length === 0) {
                        currentClientState.fields = activeTemplate.map(f => ({
                            ...f, 
                            currentValue: ''
                        }));
                    }
                    console.log(`✓ Template initialized: ${activeTemplate.length} fields`);
                    return;
                }

                // Real-time context sync (CRITICAL for context awareness)
                const jsonMsg = JSON.parse(msgStr);
                if (jsonMsg.type === 'contextUpdate') {
                    currentClientState.fields = jsonMsg.fields;
                    currentClientState.userNotes = jsonMsg.userNotes;

                    // Always sync activeTemplate when we get valid field data
                    if (jsonMsg.fields && jsonMsg.fields.length > 0) {
                        
                        // [NEW] Smart Reset: Check if fields changed
                        // This allows retro-active analysis if user adds a field mid-stream
                        const oldIds = activeTemplate.map(f => f.id).sort().join(',');
                        const newIds = jsonMsg.fields.map(f => f.id).sort().join(',');
                        
                        if (oldIds !== newIds) {
                            console.log("🔄 Field structure changed! Resetting cursor to analyze full transcript...");
                            processedTranscriptLength = 0; // The Reset
                        }

                        activeTemplate = jsonMsg.fields;
                        console.log(`✓ Context synced: ${activeTemplate.length} fields | Notes: ${currentClientState.userNotes ? 'Yes' : 'No'}`);
                    }
                    return;
                }
            } catch(e) { 
                // Silently ignore non-JSON messages
            }
            return;
        }

        // Handle audio stream
        if (isMsgBinary) {
            const sessionAge = (Date.now() - connectionStartTime) / 60000;
            
            // Refresh Deepgram connection every 55 minutes (prevents timeout)
            if (sessionAge > 55 || !dgConnection) {
                if (dgConnection) {
                    console.log("🔄 Refreshing Deepgram connection...");
                    dgConnection.finish();
                }
                setupDeepgram();
                connectionStartTime = Date.now();
                
                // Start heartbeat on first audio
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
        console.log("✓ Client disconnected");
    });

    ws.on('error', (err) => {
        console.error("❌ WebSocket Error:", err.message);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Gemini Delta Server v2 active on port ${PORT}`));
