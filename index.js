const express = require("express");
const cors    = require("cors");

const app = express();
app.use(cors());
app.use(express.json());


// ╔══════════════════════════════════════════════════════════════╗
// ║                        ОЧЕРЕДИ                              ║
// ╚══════════════════════════════════════════════════════════════╝

const queues = {
    // ── Deadlock ──────────────────────────────────────────────
    deadlock:      [],   // Обычный поиск (ранг + уровень)
    free_deadlock: [],   // Лояльный поиск (без ограничений)

    // ── Dota 2 ────────────────────────────────────────────────
    dota2:         [],   // Обычный поиск (MMR)
    free_dota2:    [],   // Лояльный поиск (без ограничений)

    // ── CS2 ───────────────────────────────────────────────────
    premier_cs2:   [],   // Premier ELO (0 – 30 000)
    faceit_cs2:    [],   // Faceit ELO  (200 – 10 000)
    free_cs2:      [],   // Лояльный поиск (без ограничений)

    // ── Valorant ──────────────────────────────────────────────
    valorant:      [],   // Обычный поиск (ранг)
    free_valorant: [],   // Лояльный поиск (без ограничений)
};

// Алиасы для /searchingByGame — суммируют под-очереди одной игры
const queueAliases = {
    deadlock: ["deadlock", "free_deadlock"],
    cs2:      ["premier_cs2", "faceit_cs2", "free_cs2"],
    dota2:    ["dota2", "free_dota2"],
    valorant: ["valorant", "free_valorant"],
};

// Буфер готовых матчей: uid → matchData
const pendingMatches = {};


// ╔══════════════════════════════════════════════════════════════╗
// ║                    КОНСТАНТЫ РЕЙТИНГОВ                      ║
// ╚══════════════════════════════════════════════════════════════╝

const DEADLOCK_RANK_ORDER = {
    INITIATE: 1, SEEKER: 2, ALCHEMIST: 3, ARCANIST: 4,
    RITUALIST: 5, EMISSARY: 6, ARCHON: 7, ORACLE: 8,
    PHANTOM: 9, ASCENDANT: 10, ETERNUS: 11,
};

const VALORANT_RANKS = [
    "Iron", "Bronze", "Silver", "Gold", "Platinum",
    "Diamond", "Ascendant", "Immortal", "Radiant",
];


// ╔══════════════════════════════════════════════════════════════╗
// ║                   ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ                   ║
// ╚══════════════════════════════════════════════════════════════╝

// Проверяет, есть ли один игрок в списке игнора другого
function isIgnored(me, other) {
    if (me.ignored    && me.ignored.includes(other.uid)) return true;
    if (other.ignored && other.ignored.includes(me.uid)) return true;
    return false;
}

// Возвращает суммарную длину нескольких очередей по массиву ключей
function sumQueues(keys) {
    return keys.reduce((sum, key) => sum + (queues[key]?.length ?? 0), 0);
}

// Удаляет игрока из всех очередей
function removeFromAllQueues(uid) {
    for (const key in queues) {
        queues[key] = queues[key].filter(p => p.uid !== uid);
    }
}


// ╔══════════════════════════════════════════════════════════════╗
// ║                    ПРАВИЛА МАТЧМЕЙКИНГА                     ║
// ╚══════════════════════════════════════════════════════════════╝

// ── Deadlock (Rank + Level → единый score) ────────────────────
// score = (rankIndex - 1) * 6 + (level - 1), диапазон 0–65
function matchDeadlock(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const meRank    = DEADLOCK_RANK_ORDER[me.params.rank];
    const otherRank = DEADLOCK_RANK_ORDER[other.params.rank];
    if (!meRank || !otherRank) return false;

    const meLevel    = me.params.level;
    const otherLevel = other.params.level;
    if (!meLevel || !otherLevel) return false;

    const meScore    = (meRank - 1) * 6 + (meLevel - 1);
    const otherScore = (otherRank - 1) * 6 + (otherLevel - 1);

    const tolerance =
        searchTime < 20 ? 3  :
        searchTime < 40 ? 6  :
        searchTime < 60 ? 12 :
        searchTime < 80 ? 18 : 30;

    return Math.abs(meScore - otherScore) <= tolerance;
}

// ── Free — без ограничений (Deadlock / Dota / Valorant) ───────
function matchFree(me, other) {
    return !isIgnored(me, other);
}

// ── Dota 2 (MMR) ──────────────────────────────────────────────
// FIX: добавлено Number() и isNaN-проверка.
// Раньше rating приходил как строка → Math.abs возвращал NaN
// и матч никогда не находился. Роли передаются тиммейту
// и не влияют на матчмейкинг.
function matchDota(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const r1 = Number(me.params.rating);
    const r2 = Number(other.params.rating);
    if (isNaN(r1) || isNaN(r2)) return false;

    const diff = Math.abs(r1 - r2);
    const tolerance =
        searchTime < 20 ? 500  :
        searchTime < 40 ? 1000 :
        searchTime < 60 ? 1500 :
        searchTime < 90 ? 2000 : 2800;

    return diff <= tolerance;
}

// ── CS2 Premier ELO (0 – 30 000) ──────────────────────────────
function matchPremierCS2(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const elo1 = Number(me.params.elo);
    const elo2 = Number(other.params.elo);
    if (!elo1 || !elo2) return false;

    const diff = Math.abs(elo1 - elo2);
    const tolerance =
        searchTime < 20 ? 1000 :
        searchTime < 40 ? 2000 :
        searchTime < 60 ? 3000 : 5000;

    return diff <= tolerance;
}

// ── CS2 Faceit ELO (200 – 10 000) ─────────────────────────────
function matchFaceitCS2(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const elo1 = Number(me.params.elo);
    const elo2 = Number(other.params.elo);
    if (!elo1 || !elo2) return false;

    const diff = Math.abs(elo1 - elo2);
    const tolerance =
        searchTime < 20 ? 100 :
        searchTime < 40 ? 200 :
        searchTime < 60 ? 300 : 400;

    return diff <= tolerance;
}

// ── CS2 Free (без ограничений) ────────────────────────────────
function matchFreeCS2(me, other) {
    return !isIgnored(me, other);
}

// ── Valorant (индекс ранга) ───────────────────────────────────
function matchValorant(me, other, searchTime) {
    if (isIgnored(me, other)) return false;

    const i1 = VALORANT_RANKS.indexOf(me.params.rank);
    const i2 = VALORANT_RANKS.indexOf(other.params.rank);
    if (i1 === -1 || i2 === -1) return false;

    const tolerance =
        searchTime < 30 ? 1 :
        searchTime < 60 ? 2 : 3;

    return Math.abs(i1 - i2) <= tolerance;
}

// ── Сборник правил ────────────────────────────────────────────
const matchRules = {
    deadlock:      matchDeadlock,
    free_deadlock: matchFree,
    dota2:         matchDota,
    free_dota2:    matchFree,
    premier_cs2:   matchPremierCS2,
    faceit_cs2:    matchFaceitCS2,
    free_cs2:      matchFreeCS2,
    valorant:      matchValorant,
    free_valorant: matchFree,
};


// ╔══════════════════════════════════════════════════════════════╗
// ║                         ЭНДПОИНТЫ                           ║
// ╚══════════════════════════════════════════════════════════════╝

// ── POST /joinQueue — вход в очередь ─────────────────────────
app.post("/joinQueue", (req, res) => {
    const { uid, game, params, ignored } = req.body;

    if (!uid || !game || !queues[game]) {
        return res.status(400).send({ error: "Invalid request" });
    }

    // Игрок не может быть одновременно в двух очередях
    removeFromAllQueues(uid);
    delete pendingMatches[uid];

    queues[game].push({
        uid,
        params,
        ignored: ignored || [],
        time: Date.now(),
    });

    console.log(`[JOIN] ${uid} → ${game} | queue size: ${queues[game].length}`);
    res.send({ ok: true });
});

// ── POST /leaveQueue — выход из очереди ──────────────────────
app.post("/leaveQueue", (req, res) => {
    const { uid, game } = req.body;

    if (!uid) return res.status(200).send({ ok: true });

    if (game && queues[game]) {
        queues[game] = queues[game].filter(p => p.uid !== uid);
    } else {
        removeFromAllQueues(uid);
    }

    delete pendingMatches[uid];
    console.log(`[LEAVE] ${uid} ← ${game || "all queues"}`);
    res.send({ ok: true });
});

// ── POST /checkMatch — поиск матча (polling) ──────────────────
app.post("/checkMatch", (req, res) => {
    const { uid, game } = req.body;

    if (!uid) return res.status(400).send({ error: "No UID" });

    // 1. Проверяем буфер готовых матчей
    if (pendingMatches[uid]) {
        const matchData = pendingMatches[uid];
        delete pendingMatches[uid];
        console.log(`[MATCH] delivered to ${uid} from buffer`);
        return res.send({ match: matchData });
    }

    // 2. Валидация очереди
    if (!queues[game]) {
        return res.status(400).send({ error: "Invalid game" });
    }

    const queue = queues[game];
    const me    = queue.find(p => p.uid === uid);
    if (!me) return res.send({ match: null });

    const searchTime = (Date.now() - me.time) / 1000;
    const matcher    = matchRules[game];

    // 3. Ищем подходящего оппонента
    for (const other of queue) {
        if (other.uid === uid) continue;

        if (matcher(me, other, searchTime)) {
            const matchId = `${uid}_${other.uid}_${Date.now()}`;

            console.log(`[MATCH] found: ${uid} ↔ ${other.uid} in ${game} after ${searchTime.toFixed(1)}s`);

            // Удаляем обоих из очереди ДО записи в буфер
            queues[game] = queue.filter(p => p.uid !== uid && p.uid !== other.uid);

            const matchForMe = {
                players:        [uid, other.uid],
                opponentId:     other.uid,
                opponentParams: other.params,
                matchId,
            };
            const matchForOther = {
                players:        [other.uid, uid],
                opponentId:     me.uid,
                opponentParams: me.params,
                matchId,
            };

            // Оппонент заберёт свой матч при следующем /checkMatch
            pendingMatches[other.uid] = matchForOther;

            return res.send({ match: matchForMe });
        }
    }

    res.send({ match: null });
});

// ── GET /totalSearching — общий онлайн по всем играм ─────────
app.get("/totalSearching", (req, res) => {
    let total = 0;
    for (const key in queues) total += queues[key].length;
    res.send({ total });
});

// ── POST /searchingByGame — онлайн по конкретной игре ─────────
app.post("/searchingByGame", (req, res) => {
    const { game } = req.body;

    // Алиас → суммируем несколько очередей одной игры
    if (queueAliases[game]) {
        const count = sumQueues(queueAliases[game]);
        return res.send({ count });
    }

    if (!queues[game]) {
        return res.status(400).send({ error: "Invalid game" });
    }

    res.send({ count: queues[game].length });
});


// ╔══════════════════════════════════════════════════════════════╗
// ║                       ЗАПУСК СЕРВЕРА                        ║
// ╚══════════════════════════════════════════════════════════════╝

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));