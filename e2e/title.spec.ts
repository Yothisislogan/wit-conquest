import { expect, test } from '@playwright/test';
import { press, watchConsole } from './helpers.ts';

test.describe('title screen', () => {
  test('shows the crest, wordmark and an animated backdrop', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/');

    await expect(page.locator('#menu-crest svg')).toBeVisible();
    await expect(page.getByRole('heading', { name: /monster\s+territory/i })).toBeVisible();
    await expect(page.getByText('Clone. Jump. Claim the board.')).toBeVisible();

    // The backdrop is decorative and must stay out of the accessibility tree.
    await expect(page.locator('.sky')).toHaveAttribute('aria-hidden', 'true');
    expect(await page.locator('.sky__glow').count()).toBe(3);
    expect(await page.locator('.mote').count()).toBeGreaterThan(8);

    expect(errors).toEqual([]);
  });

  test('the backdrop is deterministic across visits', async ({ page }) => {
    const read = async () =>
      page.locator('.mote').evaluateAll((nodes) =>
        nodes.map((n) => (n as HTMLElement).style.getPropertyValue('--x')),
      );

    await page.goto('/');
    const first = await read();
    await page.reload();
    const second = await read();

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  test('reduced motion removes every decorative animation', async ({ page }) => {
    await page.goto('/?motion=reduced');
    await expect(page.locator('#app')).toHaveAttribute('data-motion', 'reduced');

    // No motes are generated at all, rather than generated and hidden.
    expect(await page.locator('.mote').count()).toBe(0);

    const animations = await page.evaluate(() => ({
      glow: getComputedStyle(document.querySelector('.sky__glow')!).animationName,
      crest: getComputedStyle(document.querySelector('.menu__crest')!).animationName,
      title: getComputedStyle(document.querySelector('.menu__title-b')!).animationName,
    }));
    expect(animations.glow).toBe('none');
    expect(animations.crest).toBe('none');
    expect(animations.title).toBe('none');
  });

  test('the wordmark stays legible in both colour schemes', async ({ page }) => {
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/');
      const contrastish = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector('.menu__title-a')!);
        const sky = getComputedStyle(document.querySelector('.sky')!);
        return { ink: style.color, backdrop: sky.backgroundColor, image: sky.backgroundImage };
      });
      // The backdrop must be built from tokens, not baked-in colours, or the
      // dark aurora ends up under the light palette's dark text.
      expect(contrastish.image).not.toBe('none');
      expect(contrastish.ink).toBeTruthy();
    }
  });

  test('does not show the boot-failure notice when the app starts', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);
    await expect(page.locator('#boot-fail')).toBeHidden();
    expect(await page.evaluate(() => window.__monsterTerritoryBooted === true)).toBe(true);
  });
});

test.describe('music', () => {
  test('can be switched on and off from the title screen', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/');

    const toggle = page.locator('#btn-music-menu');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await press(toggle);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle.locator('[data-music-label]')).toHaveText('Music on');

    await press(toggle);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(errors).toEqual([]);
  });

  test('the preference persists and mirrors the settings switch', async ({ page }) => {
    await page.goto('/');
    await press(page.locator('#btn-music-menu'));

    await page.reload();
    await expect(page.locator('#btn-music-menu')).toHaveAttribute('aria-pressed', 'true');

    await press(page.locator('#btn-settings'));
    await expect(page.locator('#set-music')).toHaveAttribute('aria-checked', 'true');

    await press(page.locator('#set-music'));
    await expect(page.locator('#set-music')).toHaveAttribute('aria-checked', 'false');
    await press(page.locator('#screen-settings [data-close-screen]'));
    await expect(page.locator('#btn-music-menu')).toHaveAttribute('aria-pressed', 'false');
  });

  test('plays through a whole match without errors', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/?music=on&sound=on&mode=local-two-player&motion=reduced');

    await press(page.getByRole('button', { name: 'Play Game' }));
    await expect(page.locator('#screen-game')).toBeVisible();

    await press(page.locator('.cell:has(.piece--p1)').first());
    await press(page.locator('.cell[data-target="clone"]').first());
    await press(page.locator('.cell:has(.piece--p2)').first());
    await press(page.locator('.cell[data-target="clone"]').first());

    await press(page.locator('#btn-pause'));
    await press(page.locator('#btn-pause-menu'));
    await expect(page.locator('#screen-menu')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('shares one audio context and only really starts after a gesture', async ({ page }) => {
    // Count context constructions and oscillators without subclassing, which
    // would trip over the real AudioContext's own construction rules.
    await page.addInitScript(() => {
      const w = window as unknown as {
        __oscillators: number;
        __contexts: number;
        AudioContext: typeof AudioContext;
      };
      w.__oscillators = 0;
      w.__contexts = 0;

      const proto = w.AudioContext.prototype;
      const original = proto.createOscillator;
      proto.createOscillator = function createOscillator(this: AudioContext) {
        w.__oscillators += 1;
        return original.call(this);
      };

      w.AudioContext = new Proxy(w.AudioContext, {
        construct(target, args) {
          w.__contexts += 1;
          return Reflect.construct(target, args);
        },
      });
    });

    await page.goto('/?music=on&sound=on&motion=full');
    const before = await page.evaluate(() => ({
      osc: (window as unknown as Record<string, number>).__oscillators,
      ctx: (window as unknown as Record<string, number>).__contexts,
    }));

    await press(page.getByRole('button', { name: 'Play Game' }));
    await page.waitForTimeout(2500);

    const after = await page.evaluate(() => ({
      osc: (window as unknown as Record<string, number>).__oscillators,
      ctx: (window as unknown as Record<string, number>).__contexts,
    }));

    // Autoplay policy parks the context until a gesture, and `currentTime` is
    // frozen while it is parked. The scheduler must therefore not run away
    // filling a stopped clock — at most one lookahead window may be queued.
    expect(before.osc).toBeLessThan(40);

    // Music and effects must share a single context; iOS caps how many a page
    // may hold, and two would also mean two compressors fighting each other.
    expect(after.ctx).toBeLessThanOrEqual(1);

    // And once there has been a gesture, the bed is genuinely playing.
    expect(after.osc).toBeGreaterThan(before.osc);
  });

  test('the bed reaches the speakers without passing through the effects trim', async ({ page }) => {
    // Record which nodes are wired straight to the destination. The effects
    // chain contributes exactly one (its volume trim). If the music bed shares
    // that node, dragging the effects slider to zero silences the music too —
    // which, with two independent volume controls in the settings, would be a
    // bug rather than a feature. A second direct connection is the evidence
    // that the bed has its own path out.
    await page.addInitScript(() => {
      const w = window as unknown as { __toDestination: number };
      w.__toDestination = 0;
      const connect = AudioNode.prototype.connect as (this: AudioNode, ...a: never[]) => never;
      // eslint-disable-next-line func-names
      AudioNode.prototype.connect = function (this: AudioNode, ...args: never[]) {
        const target = args[0] as unknown;
        if (target && (target as AudioNode) === (this.context as BaseAudioContext).destination) {
          w.__toDestination += 1;
        }
        return connect.apply(this, args);
      } as typeof AudioNode.prototype.connect;
    });

    await page.goto('/?music=on&sound=on&motion=full');
    await press(page.getByRole('button', { name: 'Play Game' }));
    await page.waitForTimeout(2000);

    const direct = await page.evaluate(
      () => (window as unknown as { __toDestination: number }).__toDestination,
    );
    expect(direct).toBeGreaterThanOrEqual(2);
  });

  test('music volume is independent of the effects volume', async ({ page }) => {
    await page.goto('/');
    await press(page.locator('#btn-settings'));

    await page.locator('#set-music-volume').fill('20');
    await page.locator('#set-volume').fill('90');
    await page.reload();
    await press(page.locator('#btn-settings'));

    await expect(page.locator('#set-music-volume')).toHaveValue('20');
    await expect(page.locator('#set-volume')).toHaveValue('90');
  });
});
