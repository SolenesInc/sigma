// Targets for tests: folders on this machine that `connector.ts` reaches, each running sigma-env as an instance with
// the ids the test sets. A test restarts an instance by giving it a new instance id, replaces it with new instance and
// files ids, and loses it by removing it; it stops the running agent by the pid the connector wrote.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const CONNECTOR = Bun.fileURLToPath(new URL("./connector.ts", import.meta.url))

export class TestTargets {
  // The real path: on macOS /tmp is a link, and a process reports its working directory under /private/tmp.
  readonly root = realpathSync(mkdtempSync("/tmp/sigma-targets-"))

  /** What `target_connector` in the home's `config.toml` is set to. */
  get connector(): [string, ...Array<string>] {
    return [process.execPath, CONNECTOR, this.root]
  }

  /** The connector as `config.toml` writes it. */
  get configToml() {
    return `target_connector = ${JSON.stringify(this.connector)}\n`
  }

  /** Adds a target whose instance and files are `instance`, and answers its work folder. */
  add(name: string, instance = `${name}-1`, files = instance): string {
    mkdirSync(join(this.root, name, "work"), { recursive: true })
    this.set(name, instance, files)
    return this.work(name)
  }

  /** The folder its conversations work in. */
  work(name: string) {
    return join(this.root, name, "work")
  }

  /** The ids the target's next sigma-env reports. */
  set(name: string, instance: string, files: string) {
    writeFileSync(join(this.root, name, "instance"), instance)
    writeFileSync(join(this.root, name, "files"), files)
  }

  /** Makes the target another machine at `from`: what the home has there is not what the target has at `to`. */
  map(name: string, from: string, to: string) {
    writeFileSync(join(this.root, name, "map"), JSON.stringify({ from, to }))
  }

  /** The pid of the target's sigma-env, as its connector wrote it. */
  pid(name: string) {
    return Number(readFileSync(join(this.root, name, "pid"), "utf8"))
  }

  /** Makes the connector refuse the target from now on. */
  remove(name: string) {
    rmSync(join(this.root, name, "instance"))
  }

  /** A shell command that kills the target's sigma-env, which a model's bash call can run on it. */
  killCommand(name: string) {
    return `kill -9 $(cat ${join(this.root, name, "pid")})`
  }

  [Symbol.dispose]() {
    rmSync(this.root, { recursive: true, force: true })
  }
}
