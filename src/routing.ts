/** Builds a hash route under Vite's configured base path for local or hosted use. */
export function buildJoinUrl(origin: string, basePath: string, roomCode: string): string {
  const url = new URL(basePath, origin)
  url.hash = `/join/${encodeURIComponent(roomCode.toUpperCase())}`
  return url.toString()
}
