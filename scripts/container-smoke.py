"""Exercise a built Context image using disposable, loopback-only synthetic storage."""
import http.client
import json
import subprocess
import sys
import time
import uuid


def main():
    image = sys.argv[1] if len(sys.argv) > 1 else "context:ci"
    suffix = uuid.uuid4().hex[:10]
    container = "context-runtime-proof-" + suffix
    volumes = ["context-data-proof-" + suffix, "context-backup-proof-" + suffix]
    mounts = ["--mount", f"type=volume,src={volumes[0]},dst=/app/data",
              "--mount", f"type=volume,src={volumes[1]},dst=/app/backups"]

    def run(args):
        return subprocess.run(args, check=True, capture_output=True, text=True)

    def current_port():
        return int(run(["docker", "port", container, "3000"]).stdout.strip().rsplit(":", 1)[1])

    try:
        args = ["docker", "run", "--detach", "--name", container, "--read-only", "--tmpfs", "/tmp",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--publish", "127.0.0.1::3000", *mounts]
        for value in ["CONTEXT_AUTH=oauth", "CONTEXT_PUBLIC_URL=https://context.kosarev.space/mcp",
                      "CONTEXT_OAUTH_ISSUER=https://context.kosarev.space/auth/realms/context",
                      "CONTEXT_OWNER_SUBJECT=synthetic-owner", "CONTEXT_DB_PATH=/app/data/context.db"]:
            args += ["--env", value]
        run(args + [image])
        port = current_port()

        def get(path, method="GET"):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
            try:
                connection.request(method, path, headers={"Host": "context.kosarev.space"})
                response = connection.getresponse()
                status = response.status
                response.read()
                return status
            finally:
                connection.close()

        def ready():
            for attempt in range(60):
                try:
                    if get("/health") == 200:
                        return
                except (OSError, http.client.HTTPException):
                    pass
                time.sleep(0.25)
            raise RuntimeError("Container health timed out")

        ready()
        assert get("/.well-known/oauth-protected-resource/mcp") == 200
        assert get("/mcp", "POST") == 401
        print("Protected container health, metadata and anonymous denial: passed", flush=True)
        insert = """import {SourceStore} from './dist/src/store.js';
const store = new SourceStore('/app/data/context.db');
console.log(JSON.stringify(store.capture({version:1, text:'Synthetic container orange kite',
origin:'fixture:container',scope:'synthetic:hosted-pilot',idempotencyKey:'container-001'}).source));
store.close();"""
        saved = json.loads(run(["docker", "exec", container, "node", "--input-type=module", "-e", insert]).stdout)
        run(["docker", "exec", container, "node", "dist/scripts/database.js", "backup",
             "/app/data/context.db", "/app/backups/snapshot.db"])
        run(["docker", "restart", container])
        # Docker can allocate a new random host port when restarting a container.
        port = current_port()
        ready()
        read = """import {SourceStore} from './dist/src/store.js';
const store = new SourceStore('/app/data/context.db');
console.log(JSON.stringify(store.search('orange kite','synthetic:hosted-pilot',10)[0]));
store.close();"""
        assert json.loads(run(["docker", "exec", container, "node", "--input-type=module", "-e", read]).stdout) == saved
        run(["docker", "stop", container])
        run(["docker", "run", "--rm", "--read-only", *mounts, image, "node", "dist/scripts/database.js",
             "restore", "/app/backups/snapshot.db", "/app/data/restored.db"])
        read = read.replace("/app/data/context.db", "/app/data/restored.db")
        assert json.loads(run(["docker", "run", "--rm", "--read-only", *mounts, image,
                               "node", "--input-type=module", "-e", read]).stdout) == saved
        assert subprocess.run(["docker", "run", "--rm", image], capture_output=True).returncode == 1
        print("Read-only non-root container restart, backup/restore and fail-closed default: passed", flush=True)
    finally:
        subprocess.run(["docker", "rm", "--force", container], capture_output=True)
        for volume in volumes:
            subprocess.run(["docker", "volume", "rm", volume], capture_output=True)


if __name__ == "__main__":
    main()
