import { HttpError, type Env } from './core';
import { type Command, type StateReply } from './state';

export async function stateCall<T>(env: Env, command: Command): Promise<T> {
  const reply = await env.STATE.getByName('lite-drop-v1').call(command) as unknown as StateReply;
  if (!reply.ok) throw new HttpError(reply.status, reply.code, reply.message, reply.retryAfter);
  return reply.data as T;
}
