const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.json({
        success: true,
        service: "Miles API",
        status: "online"
    });
});

app.listen(PORT, () => {
    console.log(`Miles API running on port ${PORT}`);
});