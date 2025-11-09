import { expect } from 'chai';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CONTEXT_FILENAME_PATTERN,
  CONTEXT_SUBDIRECTORIES,
  convertContextToEnumPayload,
  findContextDirectoryForPath,
  hasContextFiles,
  loadContextFromDirectory,
  type FileSystemHost
} from '../src/features/khTables/enumContext';
import { detectKhTablesMarkers } from '../src/features/khTables/detection';

describe('enumContext utilities', () => {
  describe('convertContextToEnumPayload', () => {
    it('returns undefined for non-object inputs', () => {
      expect(convertContextToEnumPayload(null)).to.be.undefined;
      expect(convertContextToEnumPayload({})).to.be.undefined;
    });

    it('normalizes enum option values and descriptions', () => {
      const payload = convertContextToEnumPayload({
        enums: {
          Rarity: {
            COMMON: 1,
            RARE: [2, 'Rare description'],
            LEGENDARY: ['gold', 'Legendary'],
            MYTHIC: { value: 'mythic', description: 'Object form' },
            PLACEHOLDER: { literal: 'todo' },
            REF: { ref: 'items.csv#alias' },
            IGNORED: null
          },
          Tags: [
            'fast',
            3,
            true,
            ['ice-damage', 'Ice description'],
            { name: 'FireDamage', value: 'fire-damage', description: 'Fire description' },
            { literal: 'earth-damage' },
            { ref: 'items.csv#alias' }
          ],
          Empty: {}
        }
      });

      expect(payload).to.not.be.undefined;
      const enums = payload!.enums;
      expect(Object.keys(enums)).to.deep.equal(['Rarity', 'Tags']);
      const rarity = enums.Rarity;
      expect(rarity).to.have.length(5);
      expect(rarity[0]).to.deep.include({ key: 'COMMON', value: '1', source: 'context' });
      expect(rarity[0].description).to.be.undefined;
      expect(rarity[1]).to.deep.equal({
        key: 'LEGENDARY',
        value: 'gold',
        description: 'Legendary',
        source: 'context'
      });
      expect(rarity[2]).to.deep.equal({
        key: 'MYTHIC',
        value: 'mythic',
        description: 'Object form',
        source: 'context'
      });
      expect(rarity[3]).to.deep.equal({
        key: 'PLACEHOLDER',
        value: 'todo',
        source: 'context'
      });
      expect(rarity[4]).to.deep.equal({
        key: 'RARE',
        value: '2',
        description: 'Rare description',
        source: 'context'
      });
      expect(enums.Tags).to.deep.equal([
        { key: 'EarthDamage', value: 'earth-damage', source: 'context' },
        { key: 'fast', value: 'fast', source: 'context' },
        { key: 'FireDamage', value: 'fire-damage', description: 'Fire description', source: 'context' },
        { key: 'IceDamage', value: 'ice-damage', description: 'Ice description', source: 'context' },
        { key: 'True', value: 'true', source: 'context' },
        { key: 'Value3', value: '3', source: 'context' }
      ]);
    });

    it('returns undefined when no enums are resolvable', () => {
      const payload = convertContextToEnumPayload({ enums: { Empty: { UNUSED: null } } });
      expect(payload).to.be.undefined;
    });
  });

  describe('context directory discovery', () => {
    let tempRoot: string;
    let workspaceRoot: string;
    let configsDir: string;

    beforeEach(async () => {
      tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tables-ext-test-'));
      workspaceRoot = path.join(tempRoot, 'workspace');
      configsDir = path.join(workspaceRoot, 'configs', 'items');
      await fs.mkdir(configsDir, { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(tempRoot, { recursive: true, force: true });
    });

    async function writeContextFile(targetDir: string, name = 'context.enums.json') {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, name), '{}', 'utf8');
    }

    it('detects context files in the same directory hierarchy', async () => {
      await writeContextFile(path.join(workspaceRoot, 'configs'));
      const result = await findContextDirectoryForPath(configsDir, { workspaceRoot });
      expect(result).to.equal(path.join(workspaceRoot, 'configs'));
    });

    it('detects context files in dedicated context subdirectories', async () => {
      await writeContextFile(path.join(configsDir, CONTEXT_SUBDIRECTORIES[0]));
      const result = await findContextDirectoryForPath(configsDir, { workspaceRoot });
      expect(result).to.equal(path.join(configsDir, CONTEXT_SUBDIRECTORIES[0]));
    });

    it('walks up to the workspace root when needed', async () => {
      await writeContextFile(workspaceRoot);
      const result = await findContextDirectoryForPath(configsDir, { workspaceRoot });
      expect(result).to.equal(workspaceRoot);
    });

    it('does not treat sibling paths with matching prefixes as workspace children', async () => {
      const siblingWorkspace = path.join(tempRoot, 'workspace-extra');
      const siblingConfig = path.join(siblingWorkspace, 'configs', 'items');
      await writeContextFile(siblingConfig);
      await writeContextFile(workspaceRoot);

      const result = await findContextDirectoryForPath(siblingConfig, { workspaceRoot });

      expect(result).to.be.undefined;
    });

    it('returns undefined when no context files are found', async () => {
      const result = await findContextDirectoryForPath(configsDir, { workspaceRoot });
      expect(result).to.be.undefined;
    });

    it('shares results through the provided cache without additional fs calls', async () => {
      await writeContextFile(workspaceRoot);
      let statCalls = 0;
      let readdirCalls = 0;
      const fileSystem: FileSystemHost = {
        stat: async (target) => {
          statCalls += 1;
          return fs.stat(target);
        },
        readdir: async (target) => {
          readdirCalls += 1;
          return fs.readdir(target);
        },
        readFile: (target) => fs.readFile(target, 'utf8')
      };
      const cache = new Map<string, string | undefined>();
      const first = await findContextDirectoryForPath(configsDir, { workspaceRoot, fileSystem, cache });
      expect(first).to.equal(workspaceRoot);
      expect(statCalls).to.be.greaterThan(0);
      expect(readdirCalls).to.be.greaterThan(0);

      const priorStatCalls = statCalls;
      const priorReaddirCalls = readdirCalls;
      const second = await findContextDirectoryForPath(configsDir, { workspaceRoot, fileSystem, cache });
      expect(second).to.equal(workspaceRoot);
      expect(statCalls).to.equal(priorStatCalls);
      expect(readdirCalls).to.equal(priorReaddirCalls);
    });

    it('hasContextFiles matches context naming conventions', async () => {
      const contextDir = path.join(workspaceRoot, 'context');
      await writeContextFile(contextDir, 'context.meta.json');
      expect(await hasContextFiles(contextDir)).to.be.true;
      const unrelatedDir = path.join(workspaceRoot, 'misc');
      await fs.mkdir(unrelatedDir, { recursive: true });
      expect(await hasContextFiles(unrelatedDir)).to.be.false;
      expect(CONTEXT_FILENAME_PATTERN.test('context.enums.json')).to.be.true;
      expect(CONTEXT_FILENAME_PATTERN.test('context.txt')).to.be.false;
    });

    it('loads and merges context JSON blobs from one directory', async () => {
      await fs.writeFile(
        path.join(configsDir, 'context.enums.json'),
        JSON.stringify({ Rarity: { COMMON: 1 } }),
        'utf8'
      );
      await fs.writeFile(
        path.join(configsDir, 'context.enums.extra.json'),
        JSON.stringify({ Rarity: { RARE: 2 }, WeaponFlag: { ENERGY: 'energy' } }),
        'utf8'
      );
      await fs.writeFile(path.join(configsDir, '~context.enums.tmp.json'), '{}', 'utf8');
      await fs.writeFile(
        path.join(configsDir, 'context.meta.json'),
        JSON.stringify({ exports: { enum: ['enums'] } }),
        'utf8'
      );

      expect(await loadContextFromDirectory(configsDir)).to.deep.equal({
        enums: {
          Rarity: { RARE: 2 },
          WeaponFlag: { ENERGY: 'energy' }
        },
        meta: { exports: { enum: ['enums'] } }
      });
    });
  });
});

describe('khTables detection utilities', () => {
  it('detects well-formed marker rows', () => {
    const detection = detectKhTablesMarkers('@,string,int\nid,name,level');

    expect(detection.hasMarkers).to.equal(true);
    expect(detection.markRowIndex).to.equal(0);
    expect(detection.tokenHits).to.include('@');
  });

  it('does not detect markers inside unclosed quoted fields', () => {
    const detection = detectKhTablesMarkers('"@|string|int\nid,name,level');

    expect(detection.hasMarkers).to.equal(false);
    expect(detection.confidence).to.equal(0);
    expect(detection.tokenHits).to.deep.equal([]);
  });

  it('treats any unclosed quoted field in the preview as malformed CSV', () => {
    const detection = detectKhTablesMarkers('@,string,int\nid,name,level\n1,"unterminated');

    expect(detection.hasMarkers).to.equal(false);
    expect(detection.confidence).to.equal(0);
    expect(detection.tokenHits).to.deep.equal([]);
  });
});
