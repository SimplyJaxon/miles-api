const express = require("express");
const { Pool } = require("pg");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// ─────────────────────────────────────────────
// Authentication
// ─────────────────────────────────────────────

function authenticate(req, res, next) {
    const key = req.headers["x-api-key"];

    if (!key || key !== process.env.MILES_API_KEY) {
        return res.status(401).json({
            success: false,
            error: "Unauthorized"
        });
    }

    next();
}

// ─────────────────────────────────────────────
// Database initialization
// ─────────────────────────────────────────────

async function initializeDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            user_id BIGINT PRIMARY KEY,
            username TEXT,
            miles BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id BIGINT NOT NULL REFERENCES users(user_id),
            amount BIGINT NOT NULL,
            balance_after BIGINT NOT NULL,
            type TEXT NOT NULL,
            reason TEXT,
            issued_by BIGINT,
            game_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS transactions_user_id_idx
        ON transactions(user_id);

        CREATE INDEX IF NOT EXISTS transactions_created_at_idx
        ON transactions(created_at);
    `);

    console.log("Miles database initialized");
}

// ─────────────────────────────────────────────
// Home / health check
// ─────────────────────────────────────────────

app.get("/", (req, res) => {
    res.json({
        success: true,
        service: "Miles API",
        status: "online"
    });
});

// ─────────────────────────────────────────────
// Get Miles
// ─────────────────────────────────────────────

app.get("/miles/:userId", authenticate, async (req, res) => {
    try {
        const userId = Number(req.params.userId);

        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({
                success: false,
                error: "Invalid user ID"
            });
        }

        const result = await pool.query(
            `
            SELECT user_id, username, miles
            FROM users
            WHERE user_id = $1
            `,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.json({
                success: true,
                userId: userId,
                username: null,
                miles: 0
            });
        }

        const user = result.rows[0];

        res.json({
            success: true,
            userId: Number(user.user_id),
            username: user.username,
            miles: Number(user.miles)
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: "Internal server error"
        });
    }
});

// ─────────────────────────────────────────────
// Issue Miles
// ─────────────────────────────────────────────

app.post("/miles/issue", authenticate, async (req, res) => {
    const client = await pool.connect();

    try {
        const {
            userId,
            username,
            amount,
            reason,
            issuedBy,
            gameId
        } = req.body;

        const id = Number(userId);
        const miles = Number(amount);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                success: false,
                error: "Invalid user ID"
            });
        }

        if (!Number.isInteger(miles) || miles <= 0) {
            return res.status(400).json({
                success: false,
                error: "Amount must be a positive integer"
            });
        }

        await client.query("BEGIN");

        // Create user if they don't exist
        await client.query(
            `
            INSERT INTO users (user_id, username, miles)
            VALUES ($1, $2, 0)
            ON CONFLICT (user_id)
            DO UPDATE SET
                username = COALESCE(EXCLUDED.username, users.username),
                updated_at = NOW()
            `,
            [id, username || null]
        );

        // Add Miles
        const result = await client.query(
            `
            UPDATE users
            SET
                miles = miles + $1,
                updated_at = NOW()
            WHERE user_id = $2
            RETURNING miles
            `,
            [miles, id]
        );

        const newBalance = Number(result.rows[0].miles);

        // Record transaction
        await client.query(
            `
            INSERT INTO transactions
            (
                user_id,
                amount,
                balance_after,
                type,
                reason,
                issued_by,
                game_id
            )
            VALUES ($1, $2, $3, 'ISSUE', $4, $5, $6)
            `,
            [
                id,
                miles,
                newBalance,
                reason || null,
                issuedBy || null,
                gameId || null
            ]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            userId: id,
            amount: miles,
            miles: newBalance
        });

    } catch (error) {
        await client.query("ROLLBACK");

        console.error(error);

        res.status(500).json({
            success: false,
            error: "Internal server error"
        });

    } finally {
        client.release();
    }
});

// ─────────────────────────────────────────────
// Remove Miles
// ─────────────────────────────────────────────

app.post("/miles/remove", authenticate, async (req, res) => {
    const client = await pool.connect();

    try {
        const {
            userId,
            amount,
            reason,
            issuedBy,
            gameId
        } = req.body;

        const id = Number(userId);
        const miles = Number(amount);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                success: false,
                error: "Invalid user ID"
            });
        }

        if (!Number.isInteger(miles) || miles <= 0) {
            return res.status(400).json({
                success: false,
                error: "Amount must be a positive integer"
            });
        }

        await client.query("BEGIN");

        const result = await client.query(
            `
            UPDATE users
            SET
                miles = GREATEST(miles - $1, 0),
                updated_at = NOW()
            WHERE user_id = $2
            RETURNING miles
            `,
            [miles, id]
        );

        if (result.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                success: false,
                error: "User does not exist"
            });
        }

        const newBalance = Number(result.rows[0].miles);

        await client.query(
            `
            INSERT INTO transactions
            (
                user_id,
                amount,
                balance_after,
                type,
                reason,
                issued_by,
                game_id
            )
            VALUES ($1, $2, $3, 'REMOVE', $4, $5, $6)
            `,
            [
                id,
                -miles,
                newBalance,
                reason || null,
                issuedBy || null,
                gameId || null
            ]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            userId: id,
            amount: -miles,
            miles: newBalance
        });

    } catch (error) {
        await client.query("ROLLBACK");

        console.error(error);

        res.status(500).json({
            success: false,
            error: "Internal server error"
        });

    } finally {
        client.release();
    }
});

// ─────────────────────────────────────────────
// Transaction History
// ─────────────────────────────────────────────

app.get("/miles/:userId/transactions", authenticate, async (req, res) => {
    try {
        const userId = Number(req.params.userId);

        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({
                success: false,
                error: "Invalid user ID"
            });
        }

        const result = await pool.query(
            `
            SELECT
                id,
                amount,
                balance_after,
                type,
                reason,
                issued_by,
                game_id,
                created_at
            FROM transactions
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 100
            `,
            [userId]
        );

        res.json({
            success: true,
            transactions: result.rows
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: "Internal server error"
        });
    }
});

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────

async function start() {
    try {
        await initializeDatabase();

        app.listen(PORT, () => {
            console.log(`Miles API running on port ${PORT}`);
        });

    } catch (error) {
        console.error("Failed to start Miles API:", error);
        process.exit(1);
    }
}

start();
