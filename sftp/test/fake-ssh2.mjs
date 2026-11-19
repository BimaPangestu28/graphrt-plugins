/**
 * A fake `ssh2` module: Client emits `ready` after host-key verification, and
 * its SFTP session is backed by a real temporary directory, with ssh2's
 * callback API, status codes (2 no such file, 3 permission denied, 4 failure)
 * and OpenSSH's rename semantics (plain rename never replaces a file).
 */
import { EventEmitter } from "node:events";
import { createReadStream, createWriteStream, promises as fileSystem } from "node:fs";

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
  return {
    realpath: (path, done) => callback(fileSystem.realpath(path), done),
    stat: (path, done) => callback(fileSystem.stat(path), done, toAttributes),
    lstat: (path, done) => callback(fileSystem.lstat(path), done, toAttributes),
    readdir: (path, done) => callback(fileSystem.readdir(path, { withFileTypes: true }).then((entries) => Promise.all(entries.map(async (entry) => ({ filename: entry.name, longname: entry.name, attrs: toAttributes(await fileSystem.lstat(`${path}/${entry.name}`)) })))), done),
    mkdir: (path, attributes, done) => callback(fileSystem.mkdir(path), typeof attributes === "function" ? attributes : done),
    rmdir: (path, done) => callback(fileSystem.rmdir(path), done),
    unlink: (path, done) => callback(fileSystem.unlink(path), done),
    rename: (from, to, done) => callback(scenario.renameOverwrites ? fileSystem.rename(from, to) : fileSystem.link(from, to).then(() => fileSystem.unlink(from)), done),
    ext_openssh_rename: (from, to, done) => callback(fileSystem.rename(from, to), done),
    createReadStream: (path, options) => createReadStream(path, options),
    createWriteStream: (path, options) => {
      log.writeFlags.push(options?.flags);
      const stream = createWriteStream(path, { flags: options?.flags ?? "w" });
      if (scenario.afterUploadWrite) stream.on("close", () => scenario.afterUploadWrite(path));
      return stream;
    },
    end: () => {},
  };
}

/**
 * Builds a fake ssh2 module.
 *
 * @param scenario - `{hostKey, connectError, authError, hang, renameOverwrites, afterUploadWrite}`; renameOverwrites
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
