import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export async function loadRemote(url) {
  const response = await fetch(url);
  return response;
}

export function loadLocal(path) {
  return readFileSync(path);
}

export function remember(key, value) {
  localStorage.setItem(key, value);
}

export function launch(command) {
  spawn(command);
}
