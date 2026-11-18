/**
 * A FIFO queue that runs async tasks one at a time. WhatsApp Web has a single
 * page per profile, so every browser operation goes through one queue.
 */

/**
 * Creates a serial task queue.
 *
 * @returns `{enqueue(task)}`; `enqueue` resolves or rejects with the task's own result (object)
 *
 * @example
 * const queue = createTaskQueue();
 * const [first, second] = await Promise.all([queue.enqueue(readChats), queue.enqueue(sendText)]); // run in order
 */
export function createTaskQueue() {
  let queueTail = Promise.resolve();
  return {
    enqueue(task) {
      const taskResult = queueTail.then(() => task());
      // A failed task must not block the ones queued after it.
      queueTail = taskResult.catch(() => {});
      return taskResult;
    },
  };
}
