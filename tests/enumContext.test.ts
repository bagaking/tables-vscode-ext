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
  type FileSystemHost
} from '../src/features/khTables/enumContext';

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
            IGNORED: null
          },
          Empty: {}
        }
      });

      expect(payload).to.not.be.undefined;
      const enums = payload!.enums;
      expect(Object.keys(enums)).to.deep.equal(['Rarity']);
      const rarity = enums.Rarity;
      expect(rarity).to.have.length(3);
      expect(rarity[0]).to.deep.include({ key: 'COMMON', value: '1', source: 'context' });
      expect(rarity[0].description).to.be.undefined;
      expect(rarity[1]).to.deep.equal({
        key: 'LEGENDARY',
        value: 'gold',
        description: 'Legendary',
        source: 'context'
      });
      expect(rarity[2]).to.deep.equal({
        key: 'RARE',
        value: '2',
        description: 'Rare description',
        source: 'context'
      });
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
        }
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
  });
});
