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
//                  ПРАВИЛА МАТЧМЕЙКИНГА (с учетом времени)
// =========================================================

// ---- DEADLOCK (Rank Index) ----
function matchDeadlock(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const meRank = deadlockRankOrder[me.params.rank];
    const otherRank = deadlockRankOrder[other.params.rank];
    if (!meRank || !otherRank) return false;

    // Расширение толерантности по рангу с течением времени
    const tolerance =
        searchTime < 20 ? 1 :
        searchTime < 40 ? 2 :
        searchTime < 60 ? 3 : 5; // Максимум 5 рангов

    return Math.abs(meRank - otherRank) <= tolerance;
}

// ---- DOTA 2 (Rating/MMR) ----
function matchDota(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const diff = Math.abs(me.params.rating - other.params.rating);

    // Расширение толерантности по MMR с течением времени
    const tolerance =
        searchTime < 20 ? 500 :
        searchTime < 40 ? 1000 :
        searchTime < 60 ? 1500 :
        searchTime < 90 ? 2000 :
        2800; // Максимум 2800 MMR

    return diff <= tolerance;
}

// ---- CS2 FACEIT ELO ----
function matchCS2(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const diff = Math.abs(me.params.elo - other.params.elo);

    // Расширение толерантности по ELO с течением времени
    const tolerance =
        searchTime < 20 ? 100 :
        searchTime < 40 ? 200 :
        searchTime < 60 ? 300 :
        400; // Максимум 400 ELO

    return diff <= tolerance;
}

// ---- RUST (hours played) ----
function matchRust(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const h1 = me.params.hours;
    const h2 = other.params.hours;

    if (!h1 || !h2 || h1 === 0 || h2 === 0) return false; 

    const diff = Math.abs(h1 - h2);
    const percent = diff / Math.max(h1, h2);

    // Расширение толерантности по проценту часов
    const tolerance =
        searchTime < 30 ? 0.20 :  // строго 20%
        searchTime < 60 ? 0.30 :  // мягче 30%
        0.40;                     // максимальный лимит 40%

    return percent <= tolerance;
}

// ---- PUBG (Rank Index) ----
function matchPubg(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const i1 = pubgRanks.indexOf(me.params.rank);
    const i2 = pubgRanks.indexOf(other.params.rank);
    if (i1 === -1 || i2 === -1) return false;

    // Расширение толерантности по рангу
    const tolerance =
        searchTime < 30 ? 1 : // Соседний ранг
        searchTime < 60 ? 2 : // Два ранга
        3; // Три ранга

    return Math.abs(i1 - i2) <= tolerance;
}

// ---- VALORANT (Rank Index) ----
function matchValorant(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const i1 = valorantRanks.indexOf(me.params.rank);
    const i2 = valorantRanks.indexOf(other.params.rank);
    if (i1 === -1 || i2 === -1) return false;

    // Расширение толерантности по рангу
    const tolerance =
        searchTime < 30 ? 1 : // Соседний ранг
        searchTime < 60 ? 2 : // Два ранга
        3; // Три ранга

    return Math.abs(i1 - i2) <= tolerance;
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
    const { uid, game, params, ignored } = req.body;

    if (!uid || !game || !queues[game]) {
        return res.status(400).send({ error: "Invalid request" });
    }
    
    // Удаляем старые записи игрока из очереди
    queues[game] = queues[game].filter(p => p.uid !== uid);
    // Удаляем старые пендинг матчи
    delete pendingMatches[uid];

    queues[game].push({
        uid,
        params,
        ignored: ignored || [], // Сохраняем черный список
        time: Date.now()
    });

    console.log(`Player ${uid} joined ${game}. Total: ${queues[game].length}`);
    res.send({ ok: true });
});

// =============== выход из очереди ===============
app.post("/leaveQueue", (req, res) => {
    const { uid, game } = req.body;

    if (!uid || !queues[game]) {
        return res.status(200).send({ ok: true });
    }
    queues[game] = queues[game].filter(p => p.uid !== uid);
    delete pendingMatches[uid]; // Чистим буфер матчей
    
    console.log(`Player ${uid} left ${game}`);
    res.send({ ok: true });
});

// =============== поиск матча ===============
app.post("/checkMatch", (req, res) => {
    const { uid, game } = req.body;

    if (!uid) return res.status(400).send({ error: "No UID" });

    // 1. Сначала проверяем буфер готовых матчей
    if (pendingMatches[uid]) {
        const matchData = pendingMatches[uid];
        delete pendingMatches[uid]; // Удаляем, чтобы не слать повторно
        console.log(`Match delivered to ${uid} from buffer`);
        return res.send({ match: matchData });
    }

    // 2. Если матча в буфере нет, проверяем валидность игры
    if (!queues[game]) {
        return res.status(400).send({ error: "Invalid game" });
    }

    const queue = queues[game];
    const me = queue.find(p => p.uid === uid);
    
    // Если игрока нет ни в очереди, ни в буфере -> null
    if (!me) return res.send({ match: null });

    const now = Date.now();
    const searchTime = (now - me.time) / 1000;
    const matcher = matchRules[game];

    for (const other of queue) {
        if (other.uid === uid) continue;

        // Здесь вызывается новая функция matcher с учетом isIgnored и searchTime
        if (matcher(me, other, searchTime)) {
            console.log(`MATCH FOUND: ${uid} + ${other.uid} in ${game} after ${searchTime.toFixed(1)}s`);

            const matchForMe = {
                players: [uid, other.uid],
                opponentId: other.uid,
                opponentParams: other.params
            };

            const matchForOther = {
                players: [other.uid, uid],
                opponentId: me.uid,
                opponentParams: me.params
            };

            // Сохраняем результат для обоих
            pendingMatches[uid] = matchForMe;
            pendingMatches[other.uid] = matchForOther;

            // Удаляем ОБОИХ из очереди поиска
            queues[game] = queue.filter(p => p.uid !== uid && p.uid !== other.uid);

            // Отдаем ответ мне (и удаляем из буфера мой экземпляр)
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

    res.send({ count: queues[game].length });
});

// =============== запуск сервера ===============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));