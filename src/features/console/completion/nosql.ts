/**
 * Completion for the command consoles: Redis command names, and the MongoDB shell's
 * `db.<collection>.<method>(…)` shape. No parsing beyond what the line so far shows.
 */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { peekSnapshot } from "./snapshots";
import type { CompletionTarget } from "./extension";

export const REDIS_COMMANDS = (
  "APPEND AUTH BGREWRITEAOF BGSAVE BITCOUNT BITFIELD BITOP BITPOS BLMOVE BLMPOP BLPOP BRPOP BRPOPLPUSH " +
  "BZMPOP BZPOPMAX BZPOPMIN CLIENT CONFIG COPY DBSIZE DECR DECRBY DEL DISCARD DUMP ECHO EVAL EVALSHA " +
  "EXEC EXISTS EXPIRE EXPIREAT EXPIRETIME FCALL FLUSHALL FLUSHDB FUNCTION GEOADD GEODIST GEOHASH GEOPOS " +
  "GEORADIUS GEOSEARCH GEOSEARCHSTORE GET GETBIT GETDEL GETEX GETRANGE GETSET HDEL HELLO HEXISTS HGET " +
  "HGETALL HINCRBY HINCRBYFLOAT HKEYS HLEN HMGET HMSET HRANDFIELD HSCAN HSET HSETNX HSTRLEN HVALS INCR " +
  "INCRBY INCRBYFLOAT INFO KEYS LASTSAVE LATENCY LCS LINDEX LINSERT LLEN LMOVE LMPOP LPOP LPOS LPUSH " +
  "LPUSHX LRANGE LREM LSET LTRIM MEMORY MGET MIGRATE MONITOR MOVE MSET MSETNX MULTI OBJECT PERSIST " +
  "PEXPIRE PEXPIREAT PEXPIRETIME PFADD PFCOUNT PFMERGE PING PSETEX PSUBSCRIBE PTTL PUBLISH PUBSUB " +
  "PUNSUBSCRIBE RANDOMKEY RENAME RENAMENX RESTORE RPOP RPOPLPUSH RPUSH RPUSHX SADD SAVE SCAN SCARD " +
  "SCRIPT SDIFF SDIFFSTORE SELECT SET SETBIT SETEX SETNX SETRANGE SINTER SINTERCARD SINTERSTORE " +
  "SISMEMBER SLOWLOG SMEMBERS SMISMEMBER SMOVE SORT SORT_RO SPOP SRANDMEMBER SREM SSCAN STRLEN " +
  "SUBSCRIBE SUNION SUNIONSTORE SWAPDB TIME TOUCH TTL TYPE UNLINK UNSUBSCRIBE UNWATCH WAIT WATCH XACK " +
  "XADD XAUTOCLAIM XCLAIM XDEL XGROUP XINFO XLEN XPENDING XRANGE XREAD XREADGROUP XREVRANGE XSETID " +
  "XTRIM ZADD ZCARD ZCOUNT ZDIFF ZDIFFSTORE ZINCRBY ZINTER ZINTERCARD ZINTERSTORE ZLEXCOUNT ZMPOP " +
  "ZMSCORE ZPOPMAX ZPOPMIN ZRANDMEMBER ZRANGE ZRANGEBYLEX ZRANGEBYSCORE ZRANGESTORE ZRANK ZREM " +
  "ZREMRANGEBYLEX ZREMRANGEBYRANK ZREMRANGEBYSCORE ZREVRANGE ZREVRANGEBYLEX ZREVRANGEBYSCORE ZREVRANK " +
  "ZSCAN ZSCORE ZUNION ZUNIONSTORE"
).split(" ");

export const MONGO_METHODS = [
  "find",
  "findOne",
  "aggregate",
  "countDocuments",
  "estimatedDocumentCount",
  "distinct",
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "createIndex",
  "dropIndex",
  "getIndexes",
  "drop",
];

export const MONGO_CURSOR = ["sort", "limit", "skip", "project", "hint", "toArray"];

const opt = (label: string, type: string, detail?: string, boost = 0): Completion => ({
  label,
  type,
  detail,
  boost,
});

/** What a Mongo line so far can be followed by. */
export function mongoOptions(
  before: string,
  collections: string[],
): { from: number; options: Completion[] } | null {
  const show = /^\s*show\s+(\w*)$/.exec(before);
  if (show) {
    return {
      from: before.length - show[1].length,
      options: ["collections", "dbs"].map((l) => opt(l, "keyword")),
    };
  }
  // after a closing paren: cursor modifiers
  const chain = /\)\s*\.(\w*)$/.exec(before);
  if (chain && /db\./.test(before)) {
    return {
      from: before.length - chain[1].length,
      options: MONGO_CURSOR.map((l) => opt(l, "function", "cursor")),
    };
  }
  const method = /db\.(\w+)\.(\w*)$/.exec(before);
  if (method) {
    return {
      from: before.length - method[2].length,
      options: MONGO_METHODS.map((l) => opt(l, "function")),
    };
  }
  const coll = /db\.(\w*)$/.exec(before);
  if (coll) {
    return {
      from: before.length - coll[1].length,
      options: [
        ...collections.map((l) => opt(l, "class", "collection", 5)),
        opt("getCollection", "function"),
      ],
    };
  }
  const word = /^\s*(\w*)$/.exec(before);
  if (word) {
    return {
      from: before.length - word[1].length,
      options: ["db", "show", "use"].map((l) => opt(l, "keyword")),
    };
  }
  return null;
}

/** The completion source for the Mongo and Redis consoles. */
export function nosqlSource(getTarget: () => CompletionTarget) {
  return (context: CompletionContext): CompletionResult | null => {
    const target = getTarget();
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    if (target.driver === "redis") {
      const m = /^\s*(\w*)$/.exec(before);
      if (!m || (!context.explicit && m[1].length === 0)) return null;
      return {
        from: context.pos - m[1].length,
        options: REDIS_COMMANDS.map((c) => opt(c, "function", undefined, 0)),
        filter: true,
        // matched case-insensitively; the command is inserted upper-case
        validFor: /^\w*$/,
      };
    }
    const snapshot = target.connected ? peekSnapshot(target.connectionId, target.database) : null;
    const collections = snapshot?.schemas.flatMap((s) => s.tables.map((t) => t.name)) ?? [];
    const found = mongoOptions(before, collections);
    if (!found || (!context.explicit && before.trim() === "")) return null;
    return {
      from: context.pos - (before.length - found.from),
      options: found.options,
      filter: true,
    };
  };
}
