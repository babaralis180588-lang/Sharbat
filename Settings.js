module.exports = {

    // ==============================
    // 🤖 ALI CYBER MD BOT CONFIG
    // ==============================

    botName: "⚡ ALI CYBER X MD BOT",
    version: "3.0.0",

    ownerName: "👑 ALI",
    ownerNumber: process.env.OWNER_NUMBER || "923011437623",

    // Bot Status
    prefix: ".",
    mode: "private",
    timezone: "Asia/Karachi",

    // API KEYS
    giphyApiKey: process.env.GIPHY_API_KEY || "dc6zaTOxFJmzC",

    // Channel
    channel: {
        name: "ALI CYBER GANG",
        url: "https://whatsapp.com/channel/0029Vb8ljdBL2ATvPcXyPP46"
    },

    // Features Default
    features: {

        autoReact: true,
        autoRead: false,
        autoTyping: true,
        autoRecording: true,

        antiCall: true,
        antiDelete: true,
        antiLink: true,

        autoStatus: false,
        aiReply: false
    },


    // Messages
    messages: {

        online:
        `
╭━━━〔 ⚡ ALI CYBER BOT 〕━━━╮

✅ System Online
🚀 Multi Device Active
🛡️ Security Enabled

Powered By Ali Cyber Gang
╰━━━━━━━━━━━━━━━━╯
        `,


        pair:
        `
🔐 Pairing System Started

⚡ Secure Connection
🤖 Ali Cyber MD Bot
        `,


        error:
        "❌ System Error Occurred"
    },


    // Security
    security: {

        sessionBackup: true,
        maxMessagesCache: 3000,
        reconnect: true,
        antiCrash: true
    },


    // Owner Commands
    ownerCommands: [
        "public",
        "private",
        "broadcast",
        "restart",
        "eval"
    ]

};
