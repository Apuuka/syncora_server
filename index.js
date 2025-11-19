const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// =============== очереди ===============
const queues = {
    deadlock: [],
    dota2: [],
    cs2: [],
    valorant: [],
    rust: [],
    pubg: []
};

// =============== deadlock матчмекинг ===============
const deadlockRankOrder = {
    "INITIATE": 1,
    "SEEKER": 2,
    "ALCHEMIST": 3,
    "ARCANIST": 4,
    "RITUALIST": 5,
    "EMISSARY": 6,
    "ARCHON": 7,
    "ORACLE": 8,
    "PHANTOM": 9,
    "ASCENDANT": 10,
    "ETERNUS": 11
};

function matchDeadlock(me, other, searchTime) {
    const meRank = deadlockRankOrder[me.params.rank];
    const otherRank = deadlockRankOrder[other.params.rank];
    if (!meRank || !otherRank) return false;

    const tolerance =
        searchTime < 20 ? 1 :
        searchTime < 40 ? 2 :
        searchTime < 60 ? 3 : 5;

    return Math.abs(meRank - otherRank) <= tolerance;
}

// =============== правила для других игр ===============
function matchDota(me, other, searchTime) {
    return Math.abs(me.params.rating - other.params.rating) < 500;
}

function matchCS2(me, other) {
    return Math.abs(me.params.rank - other.params.rank) <= 3;
}

function matchValorant(me, other) {
    return Math.abs(me.params.rank - other.params.rank) <= 2;
}

function matchRust() {
    return true;
}

function matchPubg(me, other) {
    return Math.abs(me.params.kd - other.params.kd) < 1.0;
}

// =============== сборник правил ===============
const matchRules = {
    deadlock: matchDeadlock,
    dota2: matchDota,
    cs2: matchCS2,
    valorant: matchValorant,
    rust: matchRust,
    pubg: matchPubg
};

// =============== вход в очередь ===============
app.post("/joinQueue", (req, res) => {
    const { uid, game, params } = req.body;

    if (!uid || !game || !queues[game]) {
        return res.status(400).send({ error: "Invalid request" });
    }

    queues[game].push({
        uid,
        params,
        time: Date.now()
    });

    console.log(`Player ${uid} joined ${game}`);
    res.send({ ok: true });
});

// =============== поиск матча ===============
app.post("/checkMatch", (req, res) => {
    const { uid, game } = req.body;

    if (!uid || !queues[game]) {
        return res.status(400).send({ error: "Invalid request" });
    }

    const queue = queues[game];
    const me = queue.find(p => p.uid === uid);
    if (!me) return res.send({ match: null });

    const now = Date.now();
    const searchTime = (now - me.time) / 1000;

    const matcher = matchRules[game];

    for (const other of queue) {
        if (other.uid === uid) continue;

        if (matcher(me, other, searchTime)) {
            console.log(`MATCH FOUND: ${uid} + ${other.uid}`);

            queues[game] = queue.filter(p => p.uid !== uid && p.uid !== other.uid);

            return res.send({
                match: {
                    players: [uid, other.uid]
                }
            });
        }
    }

    res.send({ match: null });
});

// =============== общее количество игроков ===============
app.get("/totalSearching", (req, res) => {
    let total = 0;
    for (const game in queues) {
        total += queues[game].length;
    }
    res.send({ total });
});

// =============== игроки по игре ===============
app.post("/searchingByGame", (req, res) => {
    const { game } = req.body;

    if (!queues[game]) {
        return res.status(400).send({ error: "Invalid game" });
    }

    res.send({ count: queues[game].length });
});

// =============== запуск сервера ===============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
