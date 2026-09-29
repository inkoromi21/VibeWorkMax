exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO content_catalog_versions(
      id,kind,logical_id,version,status,data_mode,payload,provenance,checked_at,expert_approval,published_at)
    VALUES
      ('00000000-0000-4000-8000-000000000201','COMPETENCY','demo-foundation',2,'PUBLISHED','DEMO_SYNTHETIC',
       '{"title":"Базовая компетенция DEMO"}','Repository synthetic fixture',now(),'APPROVED',now()),
      ('00000000-0000-4000-8000-000000000202','LEARNING_BLOCK','demo-learning-block',2,'PUBLISHED','DEMO_SYNTHETIC',
       '{"title":"Разобрать основу","durationMinutes":15,"competencyVersionId":"00000000-0000-4000-8000-000000000201"}',
       'Repository synthetic fixture',now(),'APPROVED',now()),
      ('00000000-0000-4000-8000-000000000204','RUBRIC','demo-rubric',2,'PUBLISHED','DEMO_SYNTHETIC',
       '{"criteria":[{"id":"response-present","description":"Ответ содержит собственное объяснение или ход решения"}]}',
       'Repository synthetic fixture',now(),'APPROVED',now()),
      ('00000000-0000-4000-8000-000000000203','TASK_TEMPLATE','demo-task',2,'PUBLISHED','DEMO_SYNTHETIC',
       '{"title":"Короткая проверяемая задача","learningBlockVersionId":"00000000-0000-4000-8000-000000000202","rubricVersionId":"00000000-0000-4000-8000-000000000204"}',
       'Repository synthetic fixture',now(),'APPROVED',now()),
      ('00000000-0000-4000-8000-000000000205','SOURCE_RECORD','demo-source',2,'PUBLISHED','DEMO_SYNTHETIC',
       '{"synthetic":true}','Repository synthetic fixture',now(),'APPROVED',now()),
      ('00000000-0000-4000-8000-000000000206','METHOD_VERSION','course-builder',2,'PUBLISHED','DEMO_SYNTHETIC',
       '{"name":"course-builder-v2"}','Repository synthetic fixture',now(),'APPROVED',now());
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM content_catalog_versions WHERE id IN (
    '00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000202',
    '00000000-0000-4000-8000-000000000203','00000000-0000-4000-8000-000000000204',
    '00000000-0000-4000-8000-000000000205','00000000-0000-4000-8000-000000000206')`);
};
