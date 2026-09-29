exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE content_catalog_versions (
      id uuid PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('COMPETENCY','LEARNING_BLOCK','TASK_TEMPLATE','RUBRIC','SOURCE_RECORD','METHOD_VERSION')),
      logical_id text NOT NULL CHECK (length(logical_id) BETWEEN 1 AND 200),
      version integer NOT NULL CHECK (version > 0),
      status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
      data_mode text NOT NULL CHECK (data_mode IN ('DEMO_SYNTHETIC','VERIFIED_SOURCE')),
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
      source_url text,
      license text,
      provenance text NOT NULL CHECK (length(provenance) > 0),
      checked_at timestamptz NOT NULL,
      expert_approval text NOT NULL CHECK (expert_approval IN ('PENDING','APPROVED')),
      published_at timestamptz,
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(kind,logical_id,version),
      CHECK (data_mode='DEMO_SYNTHETIC' OR (source_url IS NOT NULL AND license IS NOT NULL)),
      CHECK (status<>'PUBLISHED' OR expert_approval='APPROVED')
    );
    CREATE INDEX content_catalog_published_idx
      ON content_catalog_versions(kind,logical_id,version DESC) WHERE status='PUBLISHED';

    INSERT INTO content_catalog_versions(
      id,kind,logical_id,version,status,data_mode,payload,provenance,checked_at,expert_approval,published_at)
    VALUES
      ('00000000-0000-4000-8000-000000000101','COMPETENCY','demo-foundation',1,'PUBLISHED','DEMO_SYNTHETIC',
       '{"title":"Базовая компетенция DEMO"}','Repository synthetic fixture',now(),'APPROVED',now()),
      ('00000000-0000-4000-8000-000000000102','LEARNING_BLOCK','demo-learning-block',1,'PUBLISHED','DEMO_SYNTHETIC',
       '{"title":"Разобрать основу","durationMinutes":15}','Repository synthetic fixture',now(),'APPROVED',now()),
      ('00000000-0000-4000-8000-000000000103','TASK_TEMPLATE','demo-task',1,'PUBLISHED','DEMO_SYNTHETIC',
       '{"title":"Короткая проверяемая задача"}','Repository synthetic fixture',now(),'APPROVED',now()),
      ('00000000-0000-4000-8000-000000000104','RUBRIC','demo-rubric',1,'PUBLISHED','DEMO_SYNTHETIC',
       '{"criteria":[]}','Repository synthetic fixture',now(),'APPROVED',now()),
      ('00000000-0000-4000-8000-000000000105','SOURCE_RECORD','demo-source',1,'PUBLISHED','DEMO_SYNTHETIC',
       '{"synthetic":true}','Repository synthetic fixture',now(),'APPROVED',now()),
      ('00000000-0000-4000-8000-000000000106','METHOD_VERSION','course-builder',1,'PUBLISHED','DEMO_SYNTHETIC',
       '{"name":"course-builder-v1"}','Repository synthetic fixture',now(),'APPROVED',now());
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS content_catalog_versions CASCADE;');
};
