>
                            try {
                                await this.sock.sendMessage(id, { text, mentions: [p] });
                            } catch (e) {}
                        }
                    }
                    if (action === 'remove' && botData.goodbyeGroups && botData.goodbyeGroups[id]) {
                        for (const p of participants) {
                            const name = p.split('@')[0];
                            const custom = botData.goodbyeGroups[id].message;
                            const text = custom
                                ? custom.replace(/@user/g, `@${name}`)
                                : `👋 *Goodbye* @${name}, take care!`;
                            try {
                                await this.sock.sendMessage(id, { text, mentions: [p] });
                            } catch (e) {}
                        }
                    }
                } catch (e) {}
            });

            this.sock.ev.on('messages.upsert', async (m) => {
                // NOTE: WhatsApp/Baileys doesn't always tag self-sent messages (fromMe)
                // in OTHER people's DMs as "notify" — sometimes they arrive as "append"
                // instead, especially right after a sync burst. Your own DM and groups
                // are almost always "notify", which is why those always worked while
                // random other-DM commands got silently dropped here before. Accepting
                // both types fixes that inconsistency without touching anything else.
                if (m.type !== 'notify' && m.type !== 'append') return;
                
                await Promise.all(m.messages.map(async (msg) => {
                    if (msg.messageStubType === 1 || msg.messageStubType === 2) {
                        this.sendLog('Received an undecryptable message.', 'warning');
                    }

                    try {
                        // NOTE: WhatsApp sometimes reports the same chat's JID with a
                        // device suffix (e.g. "923xxxxxxx:5@s.whatsapp.net") instead of
                        // the plain form. Normalizing here means .ban/.block/.antilink
                        // lookups below always match the same key, instead of randomly
                        // missing depending on which JID variant this particular message
                        // came in as — this is what caused commands to silently work in
                        // some messages and get silently dropped in others, only in that
                        // one chat.
                        const from = jidNormalizedUser(msg.key.remoteJid);
                        const isMe = msg.key.fromMe;
                        const isGroup = from.endsWith('@g.us');

                        // 🛑 CRITICAL FIX — stale / history-replay message guard.
                        // On reconnect (flaky network, host restarts, etc.) WhatsApp
                        // re-sends recent chat history as "append" events. Without this
                        // check, the bot was treating those OLD messages as brand-new
                        // commands and re-running/re-sending them — every reconnect
                        // meant old replies (including empty-caption media and
                        // keep-alive style messages) went out again, to whichever
                        // chat/group/DM they originally happened in. This is almost
                        // certainly the "random unlimited messages" issue — any message
                        // older than 60 seconds by the time it reaches us is a replay,
                        // not a live message, so we skip it entirely.
                        let msgTs = msg.messageTimestamp;
                        if (msgTs && typeof msgTs === 'object') msgTs = msgTs.low ?? msgTs.toNumber?.() ?? 0;
                        msgTs = Number(msgTs) * 1000;
                        if (msgTs && (Date.now() - msgTs > 60 * 1000)) return;

                        if (isGroup) {
                            if (!botData.knownGroups) botData.knownGroups = {};
                            if (!botData.knownGroups[from]) { botData.knownGroups[from] = true; saveBotData(); }
                        } else if (from !== 'status@broadcast' && !isMe) {
                            // Track individual DM users (for the Admin Panel's DM Broadcast feature)
                            if (!botData.knownUsers) botData.knownUsers = {};
                            if (!botData.knownUsers[from]) { botData.knownUsers[from] = true; saveBotData(); }
                        }
                        const isStatus = from === 'status@broadcast';
                        
                        const messageContent = msg.message?.ephemeralMessage?.message || msg.message?.viewOnceMessage?.message || msg.message?.viewOnceMessageV2?.message || msg.message;
                        if (!messageContent) return;
                        
                        let type = Object.keys(messageContent)[0];
                        let buttonReplyId = null;
                        try {
                            const rawParams = messageContent.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
                            if (rawParams) buttonReplyId = JSON.parse(rawParams)?.id || null;
                        } catch (e) {}
                        const text = (messageContent.conversation || messageContent.extendedTextMessage?.text || messageContent.imageMessage?.caption || messageContent.videoMessage?.caption || buttonReplyId || '').trim();

                        const botNumber = jidNormalizedUser(this.sock.user.id);
                        const sender = jidNormalizedUser(msg.key.participant || from);
                        const isOwner = isMe || sender.includes(botNumber.split('@')[0]);

                        // TEMP DEBUG: logs every command as it's received, straight to the
                        // web dashboard console. If a command doesn't reply on WhatsApp,
                        // check this log for that exact time — if the line is missing,
                        // the bot never got the message (a receive/session problem). If
                        // the line IS there, the reply itself is failing to send (check
                        // the "Command error" log right after it). Remove this once the
                        // DM issue is confirmed fixed.
                        if (typeof text === 'string' && commandConfig.isCommandText(text)) {
                            this.sendLog(`DEBUG: got "${text}" from ${from} (fromMe:${isMe}, owner:${isOwner})`, 'info');
                        }

                        if (botData.blockedUsers && botData.blockedUsers[sender]) return;

                        // 🔒 Admin Panel ban — banned users get zero response from the bot
                        if (botData.appBannedUsers && botData.appBannedUsers[sender]) return;

                        if (botData.bannedChats && botData.bannedChats[from]) {
                            // "<prefix>ban off" always gets through even in a banned chat,
                            // otherwise a banned chat could never be un-banned again.
                            const banOffCmd = commandConfig.getPrefix() + 'ban off';
                            if (typeof text === 'string' && !text.toLowerCase().startsWith(banOffCmd)) return;
                        }

                        if (!isMe && !isStatus) {
                            await handleAutoread(this.sock, msg);
                            await storeMessage(msg, botData, this.userId);
                        }

                        if (msg.message?.protocolMessage?.type === 0) {
                            await handleMessageRevocation(this.sock, msg, botData, this.userId);
                            return;
                        }

                        // ✏️ Anti-edit — opt-in only (same pattern as antidelete above, gated
                        // from day one this time). WhatsApp represents an edited message as a
                        // protocolMessage of type MESSAGE_EDIT (value 14).
                        // MESSAGE_EDIT is type 14 in the WhatsApp protocol; prefer the
                        // named proto constant when available so this stays correct
                        // even if the numeric value ever changes in a future Baileys/WA update.
                        const EDIT_TYPE = proto?.Message?.ProtocolMessage?.Type?.MESSAGE_EDIT ?? 14;
                        if (msg.message?.protocolMessage?.type === EDIT_TYPE && botData.antiEdit && botData.antiEdit[this.userId]) {
                            try {
                                const editedMsg = msg.message.protocolMessage.editedMessage;
                                const newText = editedMsg?.conversation || editedMsg?.extendedTextMessage?.text || '(non-text content)';
                                const editedId = msg.message.protocolMessage.key?.id;
                                const originalText = (editedId && messageLogs[editedId] && messageLogs[editedId].text) || '(original not available)';
                                const ownerNumber = jidNormalizedUser(this.sock.user.id);
                                await this.sock.sendMessage(ownerNumber, {
                                    text: `✏️ *Message Edited*\n\n📍 Chat: ${from}\n👤 By: ${sender.split('@')[0]}\n\n*Before:* ${originalText}\n*After:* ${newText}`
                                });
                            } catch (e) {}
                            return;
                        }

                        const msgId = msg.key.id;
                        if (this.processedMessages.has(msgId)) return;
                        this.processedMessages.add(msgId);
                        if (this.processedMessages.size > 1000) this.processedMessages.delete(this.processedMessages.values().next().value);

                        if (!isStatus) {
                            let logEntry = { text, type };
                            logEntry.pushName = msg.pushName || 'User';
                            messageLogs[msgId] = logEntry;
                            // cap unbounded growth — same idea as processedMessages above
                            const logKeys = Object.keys(messageLogs);
                            if (logKeys.length > 2000) delete messageLogs[logKeys[0]];
                        }

                        if (this.autoReact && !isMe && !isStatus) {
                            const emojis = ['❤️', '👍', '🔥', '✨', '⭐', '✅', '🤖', '⚡', '💯'];
                            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                            try { await this.sock.sendMessage(from, { react: { text: randomEmoji, key: msg.key } }); } catch (e) {}
                        }

                        if (this.aiEnabled && !isMe && !isStatus && !isGroup && text && !commandConfig.isCommandText(text)) {
                            try {
                                const aiResponse = await this.getAIResponse(from, text);
                                await this.sock.sendMessage(from, { text: aiResponse }, { quoted: msg });
                            } catch (e) {}
                        }

                        if (isStatus && !isMe) {
                            // 📢 Status-mention alert — opt-in, notifies owner in DM if
                            // someone @mentions them in their status update.
                            if (botData.statusMention && botData.statusMention[this.userId]) {
                                try {
                                    const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid
                                        || msg.message?.imageMessage?.contextInfo?.mentionedJid
                                        || msg.message?.videoMessage?.contextInfo?.mentionedJid || [];
                                    const ownerNumber = jidNormalizedUser(this.sock.user.id);
                                    if (mentions.includes(ownerNumber)) {
                                        await this.sock.sendMessage(ownerNumber, {
                                            text: `📢 *You were mentioned in a status!*\n\n👤 By: ${sender.split('@')[0]}`
                                        });
                                    }
                                } catch (e) {}
                            }
                            await handleStatusUpdate(this.sock, m, botData, this.userId);
                            return;
                        }

                        let isAdmin = isOwner;
                        if (!isAdmin && isGroup) {
                            try {
                                const groupMetadata = await this.sock.groupMetadata(from);
                                const participant = groupMetadata.participants.find(p => p.id === sender);
                                isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
                            } catch (e) { isAdmin = false; }
                        }
                        const cmd = text.toLowerCase();
                        const args = text.split(' ').slice(1);
                        const q = args.join(' ');

                        if (isGroup && botData.antiStatusGroups && botData.antiStatusGroups[from] && !isAdmin) {
                            if (msg.message?.forwardingScore > 0 || text.includes('whatsapp.com/channel/')) {
                                try { await this.sock.sendMessage(from, { delete: msg.key }); return; } catch (e) {}
                            }
                        }

                        if (isGroup && botData.antilinkGroups[from] && !isAdmin) {
                            const linkPatterns = [/chat.whatsapp.com\//i, /http:\/\//i, /https:\/\//i, /www\./i];
                            if (linkPatterns.some(pattern => pattern.test(text))) {
                                try {
                                    const mode = botData.antilinkGroups[from];
                                    await this.sock.sendMessage(from, { delete: msg.key });
                                    if (mode === 'kick') await this.sock.groupParticipantsUpdate(from, [sender], "remove");
                                } catch (e) {}
                                return;
                            }
                        }

                        // 🔇 Mute enforcement — muted users get their messages silently deleted
                        if (isGroup && !isAdmin && botData.mutedUsers && botData.mutedUsers[from] && botData.mutedUsers[from][sender]) {
                            try { await this.sock.sendMessage(from, { delete: msg.key }); } catch (e) {}
                            return;
                        }

                        // 🚨 Anti-spam (flood control) enforcement
                        if (isGroup && !isAdmin && botData.antiSpam && botData.antiSpam[from]) {
                            if (moderation.checkSpam(from, sender)) {
                                try { await this.sock.sendMessage(from, { delete: msg.key }); } catch (e) {}
                                return;
                            }
                        }

                        // 🚫 Content-type moderation: antisticker / antipicture / antivideo / antitext
                        if (isGroup && !isAdmin) {
                            const mKeys = msg.message ? Object.keys(msg.message) : [];
                            const isSticker = mKeys.includes('stickerMessage');
                            const isPicture = mKeys.includes('imageMessage');
                            const isVideoMsg = mKeys.includes('videoMessage');
                            const isPlainText = !!text && !isSticker && !isPicture && !isVideoMsg;

                            if (isSticker && botData.antiSticker && botData.antiSticker[from]) {
                                try { await this.sock.sendMessage(from, { delete: msg.key }); } catch (e) {}
                                return;
                            }
                            if (isPicture && botData.antiPicture && botData.antiPicture[from]) {
                                try { await this.sock.sendMessage(from, { delete: msg.key }); } catch (e) {}
                                return;
                            }
                            if (isVideoMsg && botData.antiVideo && botData.antiVideo[from]) {
                                try { await this.sock.sendMessage(from, { delete: msg.key }); } catch (e) {}
                                return;
                            }
                            if (isPlainText && botData.antiText && botData.antiText[from] && !commandConfig.isCommandText(text)) {
                                try { await this.sock.sendMessage(from, { delete: msg.key }); } catch (e) {}
                                return;
                            }
                        }

                        // 🤬 Built-in bad-word filter (separate from the custom .filter wordlist)
                        if (isGroup && !isAdmin && botData.antiBadword && botData.antiBadword[from] && text) {
                            const lower = text.toLowerCase();
                            if (moderation.BAD_WORDS_DEFAULT.some(w => lower.includes(w))) {
                                try { await this.sock.sendMessage(from, { delete: msg.key }); } catch (e) {}
                                return;
                            }
                        }

                        // 🧹 Word filter enforcement
                        if (isGroup && !isAdmin && botData.filterWords && botData.filterWords[from] && botData.filterWords[from].length && text) {
                            const lower = text.toLowerCase();
                            if (botData.filterWords[from].some(w => lower.includes(w))) {
                                try { await this.sock.sendMessage(from, { delete: msg.key }); } catch (e) {}
                                return;
                            }
                        }

                        // 🐢 Slow mode enforcement
                        if (isGroup && !isAdmin && botData.slowMode && botData.slowMode[from] && text) {
                            if (!botData.slowModeLast) botData.slowModeLast = {};
                            if (!botData.slowModeLast[from]) botData.slowModeLast[from] = {};
                            const last = botData.slowModeLast[from][sender] || 0;
                            const waitMs = botData.slowMode[from] * 1000;
                            if (Date.now() - last < waitMs) {
                                try { await this.sock.sendMessage(from, { delete: msg.key }); } catch (e) {}
                                return;
                            }
                            botData.slowModeLast[from][sender] = Date.now();
                        }

                        // 🤖 Keyword auto-responder (only for non-command text)
                        if (botData.autoResponders && botData.autoResponders[from] && botData.autoResponders[from].length && text && !commandConfig.isCommandText(text)) {
                            const lower = text.toLowerCase();
                            const match = botData.autoResponders[from].find(a => lower.includes(a.keyword));
                            if (match) {
                                try { await this.sock.sendMessage(from, { text: match.reply }, { quoted: msg }); } catch (e) {}
                            }
                        }


                        if (!this.isPublic && !isOwner) return;

                        // 🎛️ Prefix / prefixless-aware command detection — reads
                        // whatever prefix + prefixless-mode the Admin Panel currently
            
