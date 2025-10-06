import * as vscode from 'vscode';
import { detectKhTablesMarkers, KhTablesDetection } from './detection';

export type KhTablesOverride = 'on' | 'off' | 'auto';

export interface KhTablesModeSnapshot {
  readonly detection: KhTablesDetection;
  readonly override: KhTablesOverride;
  readonly active: boolean;
}

interface PersistedState {
  readonly overrides: Record<string, Exclude<KhTablesOverride, 'auto'>>;
}

const STORAGE_KEY = 'khTables.overrides';

export class KhTablesModeService {
  private overrides: Map<string, Exclude<KhTablesOverride, 'auto'>>;

  public constructor(private readonly memento: vscode.Memento) {
    const stored = this.memento.get<PersistedState>(STORAGE_KEY);
    this.overrides = new Map(Object.entries(stored?.overrides ?? {}));
  }

  public evaluate(document: vscode.TextDocument): KhTablesModeSnapshot {
    const detection = detectKhTablesMarkers(document.getText());
    const override = this.getOverride(document.uri);
    const active = this.computeActiveState(detection, override);
    return { detection, override, active };
  }

  public setOverride(uri: vscode.Uri, override: KhTablesOverride): void {
    const key = uri.toString();
    if (override === 'auto') {
      this.overrides.delete(key);
    } else {
      this.overrides.set(key, override);
    }
    void this.persist();
  }

  public getOverride(uri: vscode.Uri): KhTablesOverride {
    const stored = this.overrides.get(uri.toString());
    return stored ?? 'auto';
  }

  private computeActiveState(detection: KhTablesDetection, override: KhTablesOverride): boolean {
    if (override === 'on') {
      return true;
    }
    if (override === 'off') {
      return false;
    }
    return detection.hasMarkers;
  }

  private async persist(): Promise<void> {
    const overrides: Record<string, Exclude<KhTablesOverride, 'auto'>> = {};
    this.overrides.forEach((value, key) => {
      overrides[key] = value;
    });
    await this.memento.update(STORAGE_KEY, { overrides });
  }
}
