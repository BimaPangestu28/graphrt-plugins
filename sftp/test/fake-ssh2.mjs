/**
 * A fake `ssh2` module: Client emits `ready` after host-key verification, and
 * its SFTP session is backed by a real temporary directory, with ssh2's
 * callback API, status codes (2 no such file, 3 permission denied, 4 failure)
 * and OpenSSH's rename semantics (plain rename never replaces a file).
 *
 * The server speaks POSIX paths, as SFTP servers do: its "/" is the local
 * directory `scenario.localRoot`, whatever paths look like on the system the
 * tests run on (`/srv/a.txt` is `<localRoot>\srv\a.txt` on Windows).
 */
import { EventEmitter } from "node:events";
import { createReadStream, createWriteStream, promises as fileSystem } from "node:fs";
import { join, relative, sep } from "node:path";

export const FAKE_HOST_KEY = Buffer.from("fake-host-key-blob");

const STATUS_BY_ERRNO = { ENOENT: 2, EACCES: 3, EPERM: 3 };

function toSftpError(fsError) {
  const sftpError = new Error(fsError.code === "ENOENT" ? "No such file" : fsError.code === "EACCES" ? "Permission denied" : "Failure");
  sftpError.code = STATUS_BY_ERRNO[fsError.code] ?? 4;
  return sftpError;
}

function toAttributes(stats) {
  return { mode: stats.mode, size: stats.size, uid: stats.uid, gid: stats.gid, atime: Math.floor(stats.atimeMs / 1000), mtime: Math.floor(stats.mtimeMs / 1000), isDirectory: () => stats.isDirectory(), isFile: () => stats.isFile(), isSymbolicLink: () => stats.isSymbolicLink() };
}

function callback(promise, done, mapValue = (value) => value) {
  promise.then((value) => done(undefined, mapValue(value)), (error) => done(toSftpError(error)));
}

function createFakeSftp(log, scenario) {
  const toLocal = (remotePath) => join(scenario.localRoot, ...String(remotePath).split("/"));
  const toRemote = (localPath) => `/${relative(scenario.localRoot, localPath).split(sep).join("/")}`;
  return {
    realpath: (path, done) => callback(fileSystem.realpath(toLocal(path)), done, toRemote),
    stat: (path, done) => callback(fileSystem.stat(toLocal(path)), done, toAttributes),
    lstat: (path, done) => callback(fileSystem.lstat(toLocal(path)), done, toAttributes),
    readdir: (path, done) => callback(fileSystem.readdir(toLocal(path), { withFileTypes: true }).then((entries) => Promise.all(entries.map(async (entry) => ({ filename: entry.name, longname: entry.name, attrs: toAttributes(await fileSystem.lstat(join(toLocal(path), entry.name))) })))), done),
    mkdir: (path, attributes, done) => callback(fileSystem.mkdir(toLocal(path)), typeof attributes === "function" ? attributes : done),
    rmdir: (path, done) => callback(fileSystem.rmdir(toLocal(path)), done),
    unlink: (path, done) => callback(fileSystem.unlink(toLocal(path)), done),
    rename: (from, to, done) => callback(scenario.renameOverwrites ? fileSystem.rename(toLocal(from), toLocal(to)) : fileSystem.link(toLocal(from), toLocal(to)).then(() => fileSystem.unlink(toLocal(from))), done),
    ext_openssh_rename: (from, to, done) => callback(fileSystem.rename(toLocal(from), toLocal(to)), done),
    createReadStream: (path, options) => createReadStream(toLocal(path), options),
    createWriteStream: (path, options) => {
      log.writeFlags.push(options?.flags);
      const stream = createWriteStream(toLocal(path), { flags: options?.flags ?? "w" });
      if (scenario.afterUploadWrite) stream.on("close", () => scenario.afterUploadWrite(path));
      return stream;
    },
    end: () => {},
  };
}

/**
 * Builds a fake ssh2 module.
 *
 * @param scenario - `{localRoot, hostKey, connectError, authError, hang, renameOverwrites, afterUploadWrite}`; localRoot
 *   is the local directory that is the server's "/", renameOverwrites
 *   makes rename replace files (non-OpenSSH servers), afterUploadWrite(path) runs when a write stream closes (object, optional)
 * @returns `{module: {Client}, log}`; log has `configs`, `ended`, `writeFlags` (object)
 */
export function createFakeSsh2(scenario = {}) {
  const log = { configs: [], ended: 0, writeFlags: [] };
  class Client extends EventEmitter {
    connect(config) {
      log.configs.push(config);
      setImmediate(() => this.handshake(config));
      return this;
    }
    handshake(config) {
      if (scenario.hang) return;
      if (scenario.connectError) return this.emit("error", Object.assign(new Error(scenario.connectError.message), scenario.connectError));
      if (!config.hostVerifier(scenario.hostKey ?? FAKE_HOST_KEY)) return this.emit("error", new Error("Host denied (verification failed)"));
      if (scenario.authError) return this.emit("error", Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" }));
      this.emit("ready");
    }
    sftp(done) {
      setImmediate(() => done(undefined, createFakeSftp(log, scenario)));
    }
    end() {
      log.ended += 1;
      this.emit("close");
    }
    destroy() {
      this.end();
    }
  }
  return { module: { Client }, log };
}
