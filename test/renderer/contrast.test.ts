import { expect } from 'chai';
import { pageTheme, contrastRatio, DARK, LIGHT, luminance, parseHex, textTheme, themeVariables, validColors } from '../../src/renderer/contrast.ts';

const rgb = (hex: string) => parseHex(hex)!;

describe('overlay contrast', () => {
  it('computes WCAG luminance and contrast', () => {
    expect(parseHex('#FF8000')).to.deep.equal([255, 128, 0]);
    expect(parseHex('fff')).to.equal(null);
    expect(luminance(rgb('#000000'))).to.equal(0);
    expect(luminance(rgb('#ffffff'))).to.equal(1);
    expect(contrastRatio(rgb('#000000'), rgb('#ffffff'))).to.be.closeTo(21, 1e-9);
    expect(contrastRatio(rgb('#777777'), rgb('#777777'))).to.equal(1);
  });

  it('puts light text on a dark wallpaper, with a light touch', () => {
    // What backdrop sampled behind the overlay on 2026-11-02
    const theme = textTheme({ background: '#3e323a', main: [
      { color: '#1e151b', share: 0.483 }, { color: '#402f39', share: 0.292 }, { color: '#51617c', share: 0.091 }, { color: '#d7cac7', share: 0.021 }
    ] });
    expect(theme.text).to.equal(rgb(LIGHT).join(', '));
    expect(theme.shadow).to.equal(rgb(DARK).join(', '));
    expect(theme.contrast).to.be.above(4.5);
    expect(theme).to.deep.include({ shadowAlpha: 0.45, upcomingAlpha: 0.5, pastAlpha: 0.32 });
  });

  it('puts dark text on a bright wallpaper', () => {
    const theme = textTheme({ background: '#e8e4d8', main: [{ color: '#f4f1ea', share: 0.7 }, { color: '#cfc8b5', share: 0.3 }] });
    expect(theme.text).to.equal(rgb(DARK).join(', '));
    expect(theme.contrast).to.be.above(10);
  });

  it('leans on the shadow when no text color reads well over every part', () => {
    // Half near-black, half near-white: whichever text wins, it is weak over one half
    const theme = textTheme({ background: '#808080', main: [{ color: '#101010', share: 0.5 }, { color: '#f0f0f0', share: 0.5 }] });
    expect(theme.contrast).to.be.below(2);
    expect(theme.shadowAlpha).to.be.above(0.75);
    expect(theme.upcomingAlpha).to.be.above(0.6);
    // Specks under 10% of the area do not count
    expect(textTheme({ background: '#202020', main: [{ color: '#202020', share: 0.95 }, { color: '#ffffff', share: 0.05 }] }).contrast).to.be.above(12);
  });

  it('takes only backdrop\'s shape from untrusted JSON, and gives CSS variables', () => {
    expect(validColors(null)).to.equal(null);
    expect(validColors({ background: 'red', main: [] })).to.equal(null);
    expect(validColors({ background: '#000000', main: 'x' })).to.equal(null);
    expect(validColors({ background: '#000000', main: [{ color: '#ffffff', share: 0.5 }, { color: 'nope', share: 1 }, { color: '#111111' }] }))
      .to.deep.equal({ background: '#000000', main: [{ color: '#ffffff', share: 0.5 }] });
    expect(themeVariables(textTheme({ background: '#000000', main: [] }))).to.deep.equal({
      '--overlay-text': '244, 246, 251', '--overlay-shadow': '18, 21, 28', '--overlay-shadow-alpha': '0.45',
      '--overlay-upcoming-alpha': '0.5', '--overlay-past-alpha': '0.32'
    });
  });
});

describe('pageTheme', () => {
  const behind = { background: '#000000', main: [{ color: '#ffffff', share: 0.5 }] };
  const cover = { background: '#ff0000', main: [{ color: '#00ff00', share: 0.5 }] };

  it('goes by what is behind the window when the page itself is see-through', () => {
    expect(pageTheme({ kind: 'transparent' }, null, behind)).to.equal(behind);
    expect(pageTheme(null, null, behind)).to.equal(behind);
    expect(pageTheme(null, null, null)).to.equal(null);
  });

  it('goes by an opaque color alone, ignoring what is behind', () => {
    expect(pageTheme({ kind: 'color', color: '#102030', alpha: 1 }, null, behind)).to.deep.equal({ background: '#102030', main: [] });
  });

  it('blends a see-through color over what is behind, or takes it alone when that is not known', () => {
    expect(pageTheme({ kind: 'color', color: '#ffffff', alpha: 0.5 }, null, behind)).to.deep.equal({ background: '#808080', main: [{ color: '#ffffff', share: 0.5 }] });
    expect(pageTheme({ kind: 'color', color: '#102030', alpha: 0.5 }, null, null)).to.deep.equal({ background: '#102030', main: [] });
  });

  it('goes by the cover when opaque, and blends it when it has an alpha', () => {
    expect(pageTheme(null, cover, behind)).to.equal(cover);
    expect(pageTheme({ kind: 'cover', alpha: null }, cover, behind)).to.equal(cover);
    expect(pageTheme({ kind: 'cover', alpha: 0.5 }, cover, behind)).to.deep.equal({ background: '#800000', main: [{ color: '#008000', share: 0.5 }] });
    expect(pageTheme({ kind: 'cover', alpha: 0.5 }, cover, null)).to.equal(cover);
    expect(pageTheme({ kind: 'cover', alpha: null }, null, behind)).to.equal(behind);
  });
});
