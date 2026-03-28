const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// =============== очереди ===============
const queues = {
    deadlock: [],
    free_deadlock: [],   // Лояльный поиск — без ограничений по рангу/уровню
    dota2: [],
    cs2: [],
    valorant: [],
    rust: [],
    pubg: []
};

// =============== хранилище готовых матчей ===============
const pendingMatches = {};

// =============== РЕЙТИНГИ И КОНСТАНТЫ ================
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

const pubgRanks = [
    "Бронза", "Серебро", "Золото", "Платина",
    "Алмаз", "Корона", "Ас", "Завоеватель"
];

const valorantRanks = [
    "Iron", "Bronze", "Silver", "Gold", "Platinum",
    "Diamond", "Ascendant", "Immortal", "Radiant"
];

// =============== УНИВЕРСАЛЬНАЯ ЛОГИКА ИГНОРА ===============
function isIgnored(me, other) {
    if (me.ignored && me.ignored.includes(other.uid)) return true;
    if (other.ignored && other.ignored.includes(me.uid)) return true;
    return false;
}

// =========================================================
//                  ПРАВИЛА МАТЧМЕЙКИНГА
// =========================================================

// ---- DEADLOCK (Rank + Level) ----
//
// Комбинированный счёт: каждый ранг содержит 6 подуровней (1–5 и ★=6).
// totalScore = (rankIndex - 1) * 6 + (level - 1)
//
// Толерантность по времени поиска:
//   < 20 сек  → ±3 подуровня (строгий)
//   < 40 сек  → ±6  (≈ 1 ранг)
//   < 60 сек  → ±12 (≈ 2 ранга)
//   < 80 сек  → ±18 (≈ 3 ранга)
//   иначе     → ±30 (≈ 5 рангов, максимум)
//
function matchDeadlock(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const meRankIndex    = deadlockRankOrder[me.params.rank];
    const otherRankIndex = deadlockRankOrder[other.params.rank];
    if (!meRankIndex || !otherRankIndex) return false;

    const meLevel    = me.params.level;
    const otherLevel = other.params.level;
    if (!meLevel || !otherLevel) return false;

    const meScore    = (meRankIndex - 1) * 6 + (meLevel - 1);
    const otherScore = (otherRankIndex - 1) * 6 + (otherLevel - 1);

    const tolerance =
        searchTime < 20 ? 3  :
        searchTime < 40 ? 6  :
        searchTime < 60 ? 12 :
        searchTime < 80 ? 18 :
        30;

    return Math.abs(meScore - otherScore) <= tolerance;
}

// ---- FREE DEADLOCK (Лояльный поиск — без ограничений) ----
function matchFreeDeadlock(me, other) {
    if (isIgnored(me, other)) return false;
    return true; // Любой с любым
}

// ---- DOTA 2 (Rating/MMR) ----
function matchDota(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const diff = Math.abs(me.params.rating - other.params.rating);

    const tolerance =
        searchTime < 20 ? 500  :
        searchTime < 40 ? 1000 :
        searchTime < 60 ? 1500 :
        searchTime < 90 ? 2000 :
        2800;

    return diff <= tolerance;
}

// ---- CS2 FACEIT ELO ----
function matchCS2(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const diff = Math.abs(me.params.elo - other.params.elo);

    const tolerance =
        searchTime < 20 ? 100 :
        searchTime < 40 ? 200 :
        searchTime < 60 ? 300 :
        400;

    return diff <= tolerance;
}

// ---- RUST (hours played) ----
function matchRust(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const h1 = me.params.hours;
    const h2 = other.params.hours;
    if (!h1 || !h2 || h1 === 0 || h2 === 0) return false;

    const diff    = Math.abs(h1 - h2);
    const percent = diff / Math.max(h1, h2);

    const tolerance =
        searchTime < 30 ? 0.20 :
        searchTime < 60 ? 0.30 :
        0.40;

    return percent <= tolerance;
}

// ---- PUBG (Rank Index) ----
function matchPubg(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const i1 = pubgRanks.indexOf(me.params.rank);
    const i2 = pubgRanks.indexOf(other.params.rank);
    if (i1 === -1 || i2 === -1) return false;

    const tolerance =
        searchTime < 30 ? 1 :
        searchTime < 60 ? 2 :
        3;

    return Math.abs(i1 - i2) <= tolerance;
}

// ---- VALORANT (Rank Index) ----
function matchValorant(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const i1 = valorantRanks.indexOf(me.params.rank);
    const i2 = valorantRanks.indexOf(other.params.rank);
    if (i1 === -1 || i2 === -1) return false;

    const tolerance =
        searchTime < 30 ? 1 :
        searchTime < 60 ? 2 :
        3;

    return Math.abs(i1 - i2) <= tolerance;
}

// =============== сборник правил ===============
const matchRules = {
    deadlock: matchDeadlock,
    free_deadlock: matchFreeDeadlock,
    dota2: matchDota,
    cs2: matchCS2,
    valorant: matchValorant,
    rust: matchRust,
    pubg: matchPubg
};

// =============== вход в очередь ===============
app.post("/joinQueue", (req, res) => {
    const { uid, game, params, ignored } = req.body;

    if (!uid || !game || !queues[game]) {
        return res.status(400).send({ error: "Invalid request" });
    }

    // Удаляем игрока из ВСЕХ очередей (не может быть в deadlock и free_deadlock одновременно)
    for (const q in queues) {
        queues[q] = queues[q].filter(p => p.uid !== uid);
    }
    delete pendingMatches[uid];

    queues[game].push({
        uid,
        params,
        ignored: ignored || [],
        time: Date.now()
    });

    console.log(`Player ${uid} joined ${game}. Total in queue: ${queues[game].length}`);
    res.send({ ok: true });
});

// =============== выход из очереди ===============
app.post("/leaveQueue", (req, res) => {
    const { uid, game } = req.body;

    if (!uid) return res.status(200).send({ ok: true });

    if (game && queues[game]) {
        queues[game] = queues[game].filter(p => p.uid !== uid);
    } else {
        for (const q in queues) {
            queues[q] = queues[q].filter(p => p.uid !== uid);
        }
    }

    delete pendingMatches[uid];
    console.log(`Player ${uid} left ${game || "all queues"}`);
    res.send({ ok: true });
});

// =============== поиск матча ===============
app.post("/checkMatch", (req, res) => {
    const { uid, game } = req.body;

    if (!uid) return res.status(400).send({ error: "No UID" });

    // 1. Проверяем буфер готовых матчей
    if (pendingMatches[uid]) {
        const matchData = pendingMatches[uid];
        delete pendingMatches[uid];
        console.log(`Match delivered to ${uid} from buffer`);
        return res.send({ match: matchData });
    }

    // 2. Проверяем валидность игры
    if (!queues[game]) {
        return res.status(400).send({ error: "Invalid game" });
    }

    const queue = queues[game];
    const me    = queue.find(p => p.uid === uid);

    if (!me) return res.send({ match: null });

    const now        = Date.now();
    const searchTime = (now - me.time) / 1000;
    const matcher    = matchRules[game];

    for (const other of queue) {
        if (other.uid === uid) continue;
 
        if (matcher(me, other, searchTime)) {
            console.log(`MATCH FOUND: ${uid} + ${other.uid} in ${game} after ${searchTime.toFixed(1)}s`);
 
            const matchId = `${uid}_${other.uid}_${Date.now()}`;
 
            const matchForMe = {
                players: [uid, other.uid],
                opponentId: other.uid,
                opponentParams: other.params,
                matchId: matchId
            };
 
            const matchForOther = {
                players: [other.uid, uid],
                opponentId: me.uid,
                opponentParams: me.params,
                matchId: matchId
            };
 
            pendingMatches[uid]       = matchForMe;
            pendingMatches[other.uid] = matchForOther;
 
            queues[game] = queue.filter(p => p.uid !== uid && p.uid !== other.uid);
 
            delete pendingMatches[uid];
            return res.send({ match: matchForMe });
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

    // FIX: для deadlock учитываем обе очереди — обычную и лояльный поиск
    let count = queues[game].length;
    if (game === "deadlock") {
        count += queues["free_deadlock"].length;
    }

    res.send({ count });
});

// =============== запуск сервера ===============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));