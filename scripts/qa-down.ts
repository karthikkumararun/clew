// Stop the local QA stack and delete its volumes.
import { DOCKER_HELP, PROFILES, clearStack, docker, dockerReachable } from "./qa-lib";

if (!dockerReachable()) {
  console.error(DOCKER_HELP);
  process.exit(1);
}
docker("compose", ...PROFILES.flatMap((p) => ["--profile", p]), "down", "-v", "--remove-orphans");
clearStack();
console.log("QA stack stopped and volumes removed.");
