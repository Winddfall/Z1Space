import type { ServerResponse } from 'node:http';
export function json(res: ServerResponse, status: number, payload: unknown, extra: Record<string, string> = {}) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }); res.end(JSON.stringify(payload)); }
export function redirect(res: ServerResponse, location: string) { res.writeHead(302, { location, 'cache-control': 'no-store' }); res.end(); }
