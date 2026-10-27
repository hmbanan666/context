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
import {KnowledgeStore} from './dist/src/knowledge.js';
import {JobStore} from './dist/src/jobs.js';
const store = new SourceStore('/app/data/context.db');
const knowledge = new KnowledgeStore('/app/data/context.db');
const jobs = new JobStore('/app/data/context.db');
const scope='synthetic:hosted-pilot';
const captured=store.capture({version:1, text:'Synthetic container orange kite',
origin:'fixture:container',scope,idempotencyKey:'container-001'});
const file=store.captureFile({version:1,scope,origin:'fixture:container-file',
idempotencyKey:'container-file',filename:'synthetic.txt',mediaType:'text/plain',
contentBase64:'U3ludGhldGljIGNvbnRhaW5lciBmaWxlDQo='});
const item=knowledge.add({version:1,scope,idempotencyKey:'container-knowledge',kind:'idea',
text:'A synthetic container kite',sourceRefs:[{sourceId:captured.source.id,quote:'orange kite'}],
creator:{kind:'model',name:'fixture:container'}});
const job=jobs.enqueue({version:1,scope,sourceId:file.material.source.id,idempotencyKey:'container-job'});
console.log(JSON.stringify({state:{source:captured.source,search:store.search('orange kite',scope,10),material:file.material,
file:store.readMaterialFile(file.material.source.id,scope),item:item.item,job:job.job},
duplicates:[captured.duplicate,file.duplicate,item.duplicate,job.duplicate]}));
jobs.close();knowledge.close();store.close();"""
        saved = json.loads(run(["docker", "exec", container, "node", "--input-type=module", "-e", insert]).stdout)
        assert saved["duplicates"] == [False, False, False, False]
        run(["docker", "exec", container, "node", "dist/scripts/database.js", "backup",
             "/app/data/context.db", "/app/backups/snapshot.db"])
        run(["docker", "restart", container])
        # Docker can allocate a new random host port when restarting a container.
        port = current_port()
        ready()
        read = insert
        repeated = json.loads(run(["docker", "exec", container, "node", "--input-type=module", "-e", read]).stdout)
        assert repeated["state"] == saved["state"]
        assert repeated["duplicates"] == [True, True, True, True]
        run(["docker", "stop", container])
        run(["docker", "run", "--rm", "--read-only", *mounts, image, "node", "dist/scripts/database.js",
             "restore", "/app/backups/snapshot.db", "/app/data/restored.db"])
        read = read.replace("/app/data/context.db", "/app/data/restored.db")
        restored = json.loads(run(["docker", "run", "--rm", "--read-only", *mounts, image,
                                  "node", "--input-type=module", "-e", read]).stdout)
        assert restored["state"] == saved["state"]
        assert restored["duplicates"] == [True, True, True, True]
        assert subprocess.run(["docker", "run", "--rm", image], capture_output=True).returncode == 1
        print("Read-only non-root container restart, backup/restore and fail-closed default: passed", flush=True)
    finally:
        subprocess.run(["docker", "rm", "--force", container], capture_output=True)
        for volume in volumes:
            subprocess.run(["docker", "volume", "rm", volume], capture_output=True)


if __name__ == "__main__":
    main()
