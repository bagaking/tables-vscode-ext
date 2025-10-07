"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
const fs_1 = require("fs");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const enumContext_1 = require("../src/features/khTables/enumContext");
describe('enumContext utilities', () => {
    describe('convertContextToEnumPayload', () => {
        it('returns undefined for non-object inputs', () => {
            (0, chai_1.expect)((0, enumContext_1.convertContextToEnumPayload)(null)).to.be.undefined;
            (0, chai_1.expect)((0, enumContext_1.convertContextToEnumPayload)({})).to.be.undefined;
        });
        it('normalizes enum option values and descriptions', () => {
            const payload = (0, enumContext_1.convertContextToEnumPayload)({
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
            (0, chai_1.expect)(payload).to.not.be.undefined;
            const enums = payload.enums;
            (0, chai_1.expect)(Object.keys(enums)).to.deep.equal(['Rarity']);
            const rarity = enums.Rarity;
            (0, chai_1.expect)(rarity).to.have.length(3);
            (0, chai_1.expect)(rarity[0]).to.deep.include({ key: 'COMMON', value: '1', source: 'context' });
            (0, chai_1.expect)(rarity[0].description).to.be.undefined;
            (0, chai_1.expect)(rarity[1]).to.deep.equal({
                key: 'LEGENDARY',
                value: 'gold',
                description: 'Legendary',
                source: 'context'
            });
            (0, chai_1.expect)(rarity[2]).to.deep.equal({
                key: 'RARE',
                value: '2',
                description: 'Rare description',
                source: 'context'
            });
        });
        it('returns undefined when no enums are resolvable', () => {
            const payload = (0, enumContext_1.convertContextToEnumPayload)({ enums: { Empty: { UNUSED: null } } });
            (0, chai_1.expect)(payload).to.be.undefined;
        });
    });
    describe('context directory discovery', () => {
        let tempRoot;
        let workspaceRoot;
        let configsDir;
        beforeEach(async () => {
            tempRoot = await fs_1.promises.mkdtemp(path.join(os.tmpdir(), 'tables-ext-test-'));
            workspaceRoot = path.join(tempRoot, 'workspace');
            configsDir = path.join(workspaceRoot, 'configs', 'items');
            await fs_1.promises.mkdir(configsDir, { recursive: true });
        });
        afterEach(async () => {
            await fs_1.promises.rm(tempRoot, { recursive: true, force: true });
        });
        async function writeContextFile(targetDir, name = 'context.enums.json') {
            await fs_1.promises.mkdir(targetDir, { recursive: true });
            await fs_1.promises.writeFile(path.join(targetDir, name), '{}', 'utf8');
        }
        it('detects context files in the same directory hierarchy', async () => {
            await writeContextFile(path.join(workspaceRoot, 'configs'));
            const result = await (0, enumContext_1.findContextDirectoryForPath)(configsDir, { workspaceRoot });
            (0, chai_1.expect)(result).to.equal(path.join(workspaceRoot, 'configs'));
        });
        it('detects context files in dedicated context subdirectories', async () => {
            await writeContextFile(path.join(configsDir, enumContext_1.CONTEXT_SUBDIRECTORIES[0]));
            const result = await (0, enumContext_1.findContextDirectoryForPath)(configsDir, { workspaceRoot });
            (0, chai_1.expect)(result).to.equal(path.join(configsDir, enumContext_1.CONTEXT_SUBDIRECTORIES[0]));
        });
        it('walks up to the workspace root when needed', async () => {
            await writeContextFile(workspaceRoot);
            const result = await (0, enumContext_1.findContextDirectoryForPath)(configsDir, { workspaceRoot });
            (0, chai_1.expect)(result).to.equal(workspaceRoot);
        });
        it('returns undefined when no context files are found', async () => {
            const result = await (0, enumContext_1.findContextDirectoryForPath)(configsDir, { workspaceRoot });
            (0, chai_1.expect)(result).to.be.undefined;
        });
        it('shares results through the provided cache without additional fs calls', async () => {
            await writeContextFile(workspaceRoot);
            let statCalls = 0;
            let readdirCalls = 0;
            const fileSystem = {
                stat: async (target) => {
                    statCalls += 1;
                    return fs_1.promises.stat(target);
                },
                readdir: async (target) => {
                    readdirCalls += 1;
                    return fs_1.promises.readdir(target);
                }
            };
            const cache = new Map();
            const first = await (0, enumContext_1.findContextDirectoryForPath)(configsDir, { workspaceRoot, fileSystem, cache });
            (0, chai_1.expect)(first).to.equal(workspaceRoot);
            (0, chai_1.expect)(statCalls).to.be.greaterThan(0);
            (0, chai_1.expect)(readdirCalls).to.be.greaterThan(0);
            const priorStatCalls = statCalls;
            const priorReaddirCalls = readdirCalls;
            const second = await (0, enumContext_1.findContextDirectoryForPath)(configsDir, { workspaceRoot, fileSystem, cache });
            (0, chai_1.expect)(second).to.equal(workspaceRoot);
            (0, chai_1.expect)(statCalls).to.equal(priorStatCalls);
            (0, chai_1.expect)(readdirCalls).to.equal(priorReaddirCalls);
        });
        it('hasContextFiles matches context naming conventions', async () => {
            const contextDir = path.join(workspaceRoot, 'context');
            await writeContextFile(contextDir, 'context.meta.json');
            (0, chai_1.expect)(await (0, enumContext_1.hasContextFiles)(contextDir)).to.be.true;
            const unrelatedDir = path.join(workspaceRoot, 'misc');
            await fs_1.promises.mkdir(unrelatedDir, { recursive: true });
            (0, chai_1.expect)(await (0, enumContext_1.hasContextFiles)(unrelatedDir)).to.be.false;
            (0, chai_1.expect)(enumContext_1.CONTEXT_FILENAME_PATTERN.test('context.enums.json')).to.be.true;
            (0, chai_1.expect)(enumContext_1.CONTEXT_FILENAME_PATTERN.test('context.txt')).to.be.false;
        });
    });
});
//# sourceMappingURL=enumContext.test.js.map