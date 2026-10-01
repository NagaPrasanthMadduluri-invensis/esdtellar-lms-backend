/**
 * pm2 process definitions for the API and the email worker.
 *
 * There was no ecosystem file before this — the API was started with pm2 CLI
 * flags, which meant its configuration lived only in whatever command
 * somebody last typed. Adding the worker made that untenable, so this file
 * now captures BOTH.
 *
 * Deploy with:
 *
 *     npm run build
 *     pm2 start ecosystem.config.js
 *     pm2 save
 *
 * Note the existing production process is named `edstellar_lms_api`. Keep
 * that name — `pm2 start` with a different one would leave the old process
 * running and bind-conflict on the port.
 */
module.exports = {
  apps: [
    {
      name: 'edstellar_lms_api',
      script: 'dist/main',
      cwd: __dirname,
      /**
       * ONE instance. Not a performance choice to revisit later:
       * `SCORM_STORAGE_DRIVER=local` and `UPLOAD_STORAGE_PATH` both write to
       * this box's disk, so a second API process cannot see what the first
       * one wrote (BACKEND_STRUCTURE §10.9, §10.10). Put both on shared
       * storage before changing this.
       */
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'edstellar_lms_worker',
      // The SAME build. `WORKER=1` makes `main.ts` fork into the worker
      // bootstrap before any HTTP setup runs, so there is no second
      // artefact to keep in step and no second deploy step.
      script: 'dist/main',
      cwd: __dirname,
      /**
       * ONE instance, and this one is load-bearing for a different reason.
       *
       * Cluster mode would run N drains against one SES quota: the per-tick
       * pacing (`EMAIL_RATE_PER_SECOND`) and the daily cap are enforced
       * per-process, so two workers send at twice the configured rate and
       * blow through the limit. pg-boss's `singletonKey` and the claim
       * query's `FOR UPDATE SKIP LOCKED` would both keep the OUTPUT correct
       * — no duplicate emails — but neither prevents exceeding the rate.
       *
       * Do not set `instances: 'max'` here.
       */
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // The worker holds one database pool of 2 and renders HTML. If it is
      // over 300M something is leaking.
      max_memory_restart: '300M',
      /**
       * Long enough for the in-flight SES call to finish. On SIGTERM the
       * drain sets its `stopping` flag, completes the message it is
       * sending, and leaves the rest of the batch claimed — the reaper
       * returns those to the queue within ten minutes.
       */
      kill_timeout: 30000,
      env: { NODE_ENV: 'production', WORKER: '1' },
    },
  ],
};
