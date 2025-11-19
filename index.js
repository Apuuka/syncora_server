const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const queues = {
    deadlock: [],
    dota2: [],
    cs2: [],
    valorant: [],
    rust: [],
    pubg: []
};

// === Хранилище готовых матчей ===
const pendingMatches = {}; 

const deadlockRankOrder = {
    "INITIATE": 1, "SEEKER": 2, "ALCHEMIST": 3, "ARCANIST": 4, "RITUALIST": 5,
    "EMISSARY": 6, "ARCHON": 7, "ORACLE": 8, "PHANTOM": 9, "ASCENDANT": 10, "ETERNUS": 11
};

// Логика сравнения Deadlock
function matchDeadlock(me, other, searchTime) {
    const meRank = deadlockRankOrder[me.params.rank];
    const otherRank = deadlockRankOrder[other.params.rank];
    if (!meRank || !otherRank) return false;

    if (me.ignored && me.ignored.includes(other.uid)) return false;
    if (other.ignored && other.ignored.includes(me.uid)) return false;

    const tolerance = searchTime < 20 ? 1 : searchTime < 40 ? 2 : searchTime < 60 ? 3 : 5;
    return Math.abs(meRank - otherRank) <= tolerance;
}

const matchRules = {
    deadlock: matchDeadlock,
    dota2: (m, o) => true,
    cs2: (m, o) => true,
    valorant: (m, o) => true,
    rust: () => true,
    pubg: (m, o) => true
};

app.post("/joinQueue", (req, res) =>
    const { uid, game, params, ignored } = req.body;

    if (!uid || !game || !queues[game]) {
        return res.status(400).send({ error: "Invalid request" });
    }
    
    queues[game] = queues[game].filter(p => p.uid !== uid);
    delete pendingMatches[uid];

    queues[game].push({
        uid,
        params,
        ignored: ignored || [],
        time: Date.now()
    });

    console.log(`Player ${uid} joined ${game}. Ignore list size: ${ignored ? ignored.length : 0}`);
    res.send({ ok: true });
});

app.post("/leaveQueue", (req, res) => {
    const { uid, game } = req.body;
    if (queues[game]) {
        queues[game] = queues[game].filter(p => p.uid !== uid);
    }
    delete pendingMatches[uid];
    res.send({ ok: true });
});

// === ОБНОВЛЕННЫЙ ПОИСК МАТЧА ===
app.post("/checkMatch", (req, res) => {
    const { uid, game } = req.body;

    // 1. Сначала проверяем, не найден ли уже матч для этого игрока
    if (pendingMatches[uid]) {
        const matchData = pendingMatches[uid];
        
        // Удаляем запись, чтобы не отправлять её вечно (одноразовое чтение)
        delete pendingMatches[uid];
        
        console.log(`Match delivered to ${uid}`);
        return res.send({ match: matchData });
    }

    // 2. Если матча в буфере нет, ищем в очереди
    if (!queues[game]) return res.status(400).send({ error: "Invalid game" });

    const queue = queues[game];
    const me = queue.find(p => p.uid === uid);

    // Если игрока нет в очереди и нет в pendingMatches -> он нигде
    if (!me) return res.send({ match: null });

    const now = Date.now();
    const searchTime = (now - me.time) / 1000;
    const matcher = matchRules[game];

    for (const other of queue) {
        if (other.uid === uid) continue;

        if (matcher(me, other, searchTime)) {
            console.log(`MATCH FOUND: ${uid} + ${other.uid}`);

            // Формируем данные матча
            const matchForMe = {
                opponentId: other.uid,
                opponentParams: other.params
            };
            const matchForOther = {
                opponentId: me.uid,
                opponentParams: me.params
            };

            // Сохраняем в буфер для ОБОИХ
            pendingMatches[uid] = matchForMe;
            pendingMatches[other.uid] = matchForOther;

            // Удаляем ОБОИХ из очереди поиска
            queues[game] = queue.filter(p => p.uid !== uid && p.uid !== other.uid);

            // Отдаем ответ текущему инициатору (мне)
            // Удаляем из pendingMatches для меня сразу, так как я уже получил ответ
            delete pendingMatches[uid]; 
            return res.send({ match: matchForMe });
        }
    }

    res.send({ match: null });
});

app.post("/searchingByGame", (req, res) => {
    const { game } = req.body;
    if (!queues[game]) return res.status(400).send({ error: "Invalid game" });
    res.send({ count: queues[game].length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));