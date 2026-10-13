#!/bin/sh
# Healthy once Neo4j answers and the seed is loaded. The first healthy-looking check loads the seed
# (docker/neo4j/seed.cypher), so `docker compose up --wait` returns with data in place.
# Test credentials; the same as NEO4J_AUTH in docker-compose.yml.
CS="cypher-shell -u neo4j -p clewclew"
$CS "RETURN 1" >/dev/null 2>&1 || exit 1
n=$($CS --format plain "MATCH (c:Category {name: 'Lighting'}) WHERE c.seeded = true RETURN count(c)" 2>/dev/null | tail -n 1)
[ "$n" = "1" ] && exit 0
$CS --file /seed/seed.cypher >/dev/null 2>&1 || exit 1
exit 0
