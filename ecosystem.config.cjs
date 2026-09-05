module.exports = {
    apps: [{
        name: "sheet-delver",
        script: "npm",
        args: "run start",
        cwd: "./",
        env: {
            NODE_ENV: "production",
            // Set this to the absolute path of your data directory.
            // The data directory contains config/, cache/, security/, modules/, and logs/.
            // If not set, the application will use ./data/ relative to cwd.
            SHEET_DELVER_DATA: "./data"
        }
    }]
};
