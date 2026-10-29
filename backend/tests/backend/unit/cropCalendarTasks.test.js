/**
 * Crop calendar fertilizer tasks.
 *
 * The production crop list has nutrient amounts per stage but no named
 * fertilizer products, so a stage can arrive with no `fertilizers` array. The
 * task text must then still be a full sentence, never a bare "Apply:".
 */
import { buildTasks } from '../../../src/services/cropCalendar.service.js';

const SOWN = new Date('2026-06-15T00:00:00Z');
const basal = (schedule) => buildTasks(SOWN, 'Wheat', schedule, 120)
  .find((t) => t.taskType === 'fertilizer_basal');

describe('crop calendar fertilizer tasks', () => {
  test('lists the fertilizers when the crop data names them', () => {
    const task = basal([{ stage: 'Basal', stageDays: 0, fertilizers: [{ name: 'DAP', quantityPerAcre: 50, unit: 'kg' }] }]);
    expect(task.description).toBe('Apply: DAP 50 kg');
    expect(task.descriptionHi).toBe('डालें: DAP 50 kg');
  });

  test('gives a full sentence, not a bare "Apply:", when no fertilizer is named', () => {
    const task = basal([{ stage: 'Basal', stageDays: 0, nutrients: { N: 20, P: 25 } }]);
    expect(task.description).not.toMatch(/^Apply:\s*$/);
    expect(task.description).toMatch(/soil health card/);
    expect(task.descriptionHi).not.toMatch(/^डालें:\s*$/);
  });

  test('an empty fertilizer list is treated the same as a missing one', () => {
    const task = basal([{ stage: 'Basal', stageDays: 0, fertilizers: [] }]);
    expect(task.description).toMatch(/soil health card/);
  });
});
