import { expect } from 'chai';
import { parseCsvToRows, toGfmMarkdown } from '../src/features/csvMarkdown';

describe('csvMarkdown utilities', () => {
  it('escapes pipes in markdown cells', () => {
    const markdown = toGfmMarkdown([
      ['name', 'pattern'],
      ['alpha|beta', 'x|y']
    ]);

    expect(markdown).to.equal('| name | pattern |\n| --- | --- |\n| alpha\\|beta | x\\|y |\n');
  });

  it('renders quoted multiline CSV cells with br separators', () => {
    const rows = parseCsvToRows('name,notes\nalpha,"line one\nline two"');

    expect(rows).to.deep.equal([
      ['name', 'notes'],
      ['alpha', 'line one\nline two']
    ]);
    expect(toGfmMarkdown(rows)).to.equal('| name | notes |\n| --- | --- |\n| alpha | line one<br/>line two |\n');
  });

  it('renders quoted CR-only multiline CSV cells with br separators', () => {
    const rows = parseCsvToRows('name,notes\ralpha,"line one\rline two"');

    expect(rows).to.deep.equal([
      ['name', 'notes'],
      ['alpha', 'line one\rline two']
    ]);
    expect(toGfmMarkdown(rows)).to.equal('| name | notes |\n| --- | --- |\n| alpha | line one<br/>line two |\n');
  });

  it('parses CRLF-delimited CSV rows', () => {
    expect(parseCsvToRows('name,count\r\nalpha,1\r\nbeta,2')).to.deep.equal([
      ['name', 'count'],
      ['alpha', '1'],
      ['beta', '2']
    ]);
  });

  it('parses CR-delimited CSV rows', () => {
    expect(parseCsvToRows('name,count\ralpha,1\rbeta,2')).to.deep.equal([
      ['name', 'count'],
      ['alpha', '1'],
      ['beta', '2']
    ]);
  });

  it('parses quoted commas and escaped quotes', () => {
    expect(parseCsvToRows('name,quote\n"alpha, beta","say ""hello"""')).to.deep.equal([
      ['name', 'quote'],
      ['alpha, beta', 'say "hello"']
    ]);
  });
});
