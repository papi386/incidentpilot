import type { RuntimeControl, RuntimeControlStore } from "../security/runtime-controls";

interface ControlRow { enabled: number; }

export class D1RuntimeControlStore implements RuntimeControlStore {
  constructor(private readonly db: D1Database) {}

  async isEnabled(control: RuntimeControl): Promise<boolean> {
    const row = await this.db.prepare(
      "SELECT enabled FROM runtime_controls WHERE control_key = ?"
    ).bind(control).first<ControlRow>();

    // Missing controls fail closed. The migration explicitly seeds every key.
    return row?.enabled === 1;
  }
}
