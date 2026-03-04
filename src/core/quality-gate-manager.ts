import Database from 'better-sqlite3';

import { EventEmitter } from './event-emitter.js';
import { TasksError } from './errors.js';
import { IdGenerator } from './id-generator.js';
import type {
  CreateGateEvaluationInput,
  CreateQualityGateInput,
  GateResult,
  GateStatus,
  QualityGate,
  UpdateQualityGateInput,
} from '../types/index.js';

function nowIso(): string {
  return new Date().toISOString();
}

interface QualityGateRow {
  id: string;
  task_id: string;
  gate_type: QualityGate['gate_type'];
  enforcement_level: QualityGate['enforcement_level'];
  exit_criteria: string;
  checker_agent: string;
  checker_backend: string | null;
  max_retries: number;
  created_at: string;
}

interface AcceptanceCriterion {
  id: string;
  verified: boolean;
}

export class QualityGateManager {
  private readonly db: Database.Database;
  private readonly idGenerator: IdGenerator;
  private readonly eventEmitter: EventEmitter;

  public constructor(db: Database.Database, idGenerator: IdGenerator, eventEmitter: EventEmitter) {
    this.db = db;
    this.idGenerator = idGenerator;
    this.eventEmitter = eventEmitter;
  }

  public create_quality_gate(input: CreateQualityGateInput, triggered_by = 'system'): QualityGate {
    this.validateExitCriteria(input.exit_criteria);
    this.ensureTaskExists(input.task_id);

    const gate_id = this.idGenerator.generate('GATE');
    const created_at = nowIso();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO quality_gates(
            id, task_id, gate_type, enforcement_level, exit_criteria,
            checker_agent, checker_backend, max_retries, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          gate_id,
          input.task_id,
          input.gate_type,
          input.enforcement_level ?? 'required',
          JSON.stringify(input.exit_criteria),
          input.checker_agent,
          input.checker_backend ?? null,
          input.max_retries ?? 3,
          created_at,
        );

      this.recalculate_gate_status(input.task_id);

      this.eventEmitter.emit_task_event({
        task_id: input.task_id,
        event_type: 'gate_created',
        data: { gate_id, gate_type: input.gate_type },
        triggered_by,
      });
    });

    tx();

    const gate = this.get_quality_gate(gate_id);
    if (!gate) {
      throw new TasksError('gate_not_found', `created gate not found: ${gate_id}`);
    }

    return gate;
  }

  public get_quality_gate(gate_id: string): QualityGate | null {
    const row = this.db
      .prepare(
        `
        SELECT id, task_id, gate_type, enforcement_level, exit_criteria,
               checker_agent, checker_backend, max_retries, created_at
        FROM quality_gates
        WHERE id = ?
        `,
      )
      .get(gate_id) as QualityGateRow | undefined;

    if (!row) {
      return null;
    }

    return this.toQualityGate(row);
  }

  public list_quality_gates(task_id?: string): QualityGate[] {
    const rows: QualityGateRow[] = task_id
      ? (this.db
          .prepare(
            `
            SELECT id, task_id, gate_type, enforcement_level, exit_criteria,
                   checker_agent, checker_backend, max_retries, created_at
            FROM quality_gates
            WHERE task_id = ?
            ORDER BY id
            `,
          )
          .all(task_id) as QualityGateRow[])
      : (this.db
          .prepare(
            `
            SELECT id, task_id, gate_type, enforcement_level, exit_criteria,
                   checker_agent, checker_backend, max_retries, created_at
            FROM quality_gates
            ORDER BY id
            `,
          )
          .all() as QualityGateRow[]);

    return rows.map((row) => this.toQualityGate(row));
  }

  public update_quality_gate(
    gate_id: string,
    input: UpdateQualityGateInput,
    triggered_by = 'system',
  ): QualityGate {
    const current = this.get_quality_gate(gate_id);
    if (!current) {
      throw new TasksError('gate_not_found', `quality gate not found: ${gate_id}`);
    }

    if (input.exit_criteria) {
      this.validateExitCriteria(input.exit_criteria);
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE quality_gates
          SET gate_type = ?,
              enforcement_level = ?,
              exit_criteria = ?,
              checker_agent = ?,
              checker_backend = ?,
              max_retries = ?
          WHERE id = ?
          `,
        )
        .run(
          input.gate_type ?? current.gate_type,
          input.enforcement_level ?? current.enforcement_level,
          JSON.stringify(input.exit_criteria ?? current.exit_criteria),
          input.checker_agent ?? current.checker_agent,
          input.checker_backend ?? current.checker_backend,
          input.max_retries ?? current.max_retries,
          gate_id,
        );

      this.recalculate_gate_status(current.task_id);

      this.eventEmitter.emit_task_event({
        task_id: current.task_id,
        event_type: 'gate_updated',
        data: { gate_id },
        triggered_by,
      });
    });

    tx();

    const updated = this.get_quality_gate(gate_id);
    if (!updated) {
      throw new TasksError('gate_not_found', `quality gate not found: ${gate_id}`);
    }

    return updated;
  }

  public delete_quality_gate(gate_id: string, triggered_by = 'system'): void {
    const gate = this.get_quality_gate(gate_id);
    if (!gate) {
      throw new TasksError('gate_not_found', `quality gate not found: ${gate_id}`);
    }

    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM quality_gates WHERE id = ?').run(gate_id);
      this.recalculate_gate_status(gate.task_id);
      this.eventEmitter.emit_task_event({
        task_id: gate.task_id,
        event_type: 'gate_deleted',
        data: { gate_id },
        triggered_by,
      });
    });

    tx();
  }

  public create_gate_evaluation(
    input: CreateGateEvaluationInput,
    triggered_by = 'system',
  ): {
    evaluation_id: number;
    gate_id: string;
    task_id: string;
    attempt: number;
    result: GateResult;
    gate_status: GateStatus;
    can_transition_to_done: boolean;
  } {
    const gate = this.get_quality_gate(input.gate_id);
    if (!gate) {
      throw new TasksError('gate_not_found', `quality gate not found: ${input.gate_id}`);
    }

    let output:
      | {
          evaluation_id: number;
          gate_id: string;
          task_id: string;
          attempt: number;
          result: GateResult;
          gate_status: GateStatus;
          can_transition_to_done: boolean;
        }
      | undefined;

    const tx = this.db.transaction(() => {
      const latest = this.db
        .prepare('SELECT MAX(attempt) AS max_attempt FROM gate_evaluations WHERE gate_id = ?')
        .get(input.gate_id) as { max_attempt: number | null };

      const attempt = (latest.max_attempt ?? 0) + 1;

      if (attempt > gate.max_retries) {
        this.eventEmitter.emit_task_event({
          task_id: gate.task_id,
          event_type: 'max_retries_exceeded',
          data: { gate_id: gate.id, max_retries: gate.max_retries },
          triggered_by,
        });

        throw new TasksError('max_retries_exceeded', 'quality gate max_retries exceeded', {
          gate_id: gate.id,
          max_retries: gate.max_retries,
        });
      }

      const info = this.db
        .prepare(
          `
          INSERT INTO gate_evaluations(
            gate_id, task_id, attempt, result, evaluator_agent,
            evaluator_backend, feedback, criteria_results,
            relay_session_id, evaluated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.gate_id,
          gate.task_id,
          attempt,
          input.result,
          input.evaluator_agent,
          input.evaluator_backend,
          input.feedback ?? null,
          JSON.stringify(input.criteria_results ?? []),
          input.relay_session_id ?? null,
          nowIso(),
        );

      const gateStatus = this.recalculate_gate_status(gate.task_id);
      this.eventEmitter.emit_task_event({
        task_id: gate.task_id,
        event_type: 'gate_evaluated',
        data: { gate_id: gate.id, result: input.result, attempt },
        triggered_by,
      });

      output = {
        evaluation_id: Number(info.lastInsertRowid),
        gate_id: gate.id,
        task_id: gate.task_id,
        attempt,
        result: input.result,
        gate_status: gateStatus,
        can_transition_to_done: gateStatus === 'passed' || gateStatus === 'none',
      };
    });

    tx();

    if (!output) {
      throw new TasksError('evaluation_failed', 'failed to create gate evaluation');
    }

    return output;
  }

  public assert_review_to_done_allowed(task_id: string, triggered_by = 'system'): void {
    this.ensureTaskExists(task_id);

    const requiredGates = this.db
      .prepare('SELECT id FROM quality_gates WHERE task_id = ? AND enforcement_level = ?')
      .all(task_id, 'required') as Array<{ id: string }>;

    for (const gate of requiredGates) {
      const latest = this.db
        .prepare(
          `
          SELECT result
          FROM gate_evaluations
          WHERE gate_id = ?
          ORDER BY attempt DESC
          LIMIT 1
          `,
        )
        .get(gate.id) as { result: GateResult } | undefined;

      if (!latest || latest.result !== 'pass') {
        this.eventEmitter.emit_task_event({
          task_id,
          event_type: 'gate_check_failed',
          data: {
            gate_id: gate.id,
            reason: latest ? 'failed' : 'not_evaluated',
          },
          triggered_by,
        });

        throw new TasksError('quality_gate_not_passed', 'required quality gate has not passed', {
          gate_id: gate.id,
        });
      }
    }

    const raw = this.db
      .prepare('SELECT acceptance_criteria FROM tasks WHERE id = ?')
      .get(task_id) as { acceptance_criteria: string | null };

    const criteria = raw.acceptance_criteria
      ? (JSON.parse(raw.acceptance_criteria) as AcceptanceCriterion[])
      : [];

    const unverified = criteria.filter((criterion) => !criterion.verified).map((criterion) => criterion.id);
    if (unverified.length > 0) {
      this.eventEmitter.emit_task_event({
        task_id,
        event_type: 'acceptance_criteria_not_met',
        data: { unverified },
        triggered_by,
      });

      throw new TasksError(
        'acceptance_criteria_not_met',
        'acceptance criteria are not fully verified',
        { unverified },
      );
    }
  }

  public recalculate_gate_status(task_id: string): GateStatus {
    const gates = this.db
      .prepare('SELECT id FROM quality_gates WHERE task_id = ?')
      .all(task_id) as Array<{ id: string }>;

    let gateStatus: GateStatus;

    if (gates.length === 0) {
      gateStatus = 'none';
    } else {
      let hasFail = false;
      let hasPending = false;

      for (const gate of gates) {
        const latest = this.db
          .prepare(
            'SELECT result FROM gate_evaluations WHERE gate_id = ? ORDER BY attempt DESC LIMIT 1',
          )
          .get(gate.id) as { result: GateResult } | undefined;

        if (!latest) {
          hasPending = true;
          continue;
        }

        if (latest.result === 'fail') {
          hasFail = true;
        }
      }

      if (hasFail) {
        gateStatus = 'failed';
      } else if (hasPending) {
        gateStatus = 'pending';
      } else {
        gateStatus = 'passed';
      }
    }

    this.db.prepare('UPDATE tasks SET gate_status = ?, updated_at = ? WHERE id = ?').run(
      gateStatus,
      nowIso(),
      task_id,
    );

    return gateStatus;
  }

  private validateExitCriteria(criteria: CreateQualityGateInput['exit_criteria']): void {
    if (!Array.isArray(criteria) || criteria.length === 0) {
      throw new TasksError('gate_no_criteria', 'exit_criteria must include at least one item');
    }
  }

  private ensureTaskExists(task_id: string): void {
    const exists = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(task_id) as
      | { id: string }
      | undefined;

    if (!exists) {
      throw new TasksError('task_not_found', `task not found: ${task_id}`);
    }
  }

  private toQualityGate(row: QualityGateRow): QualityGate {
    return {
      id: row.id,
      task_id: row.task_id,
      gate_type: row.gate_type,
      enforcement_level: row.enforcement_level,
      exit_criteria: JSON.parse(row.exit_criteria),
      checker_agent: row.checker_agent,
      checker_backend: row.checker_backend,
      max_retries: row.max_retries,
      created_at: row.created_at,
    };
  }
}
