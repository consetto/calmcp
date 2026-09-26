// Worked multi-step recipes surfaced by `calm_resources`, so clients know how to chain queries.

/** A worked, multi-step example showing an AI client how to answer a common question. */
export interface Recipe {
  question: string;
  steps: string[];
}

/** Ready-made recipes surfaced by `calm_resources` so clients know how to chain queries. */
export const RECIPES: Recipe[] = [
  {
    question: 'How many user stories are there in the tenant?',
    steps: [
      "Start here: calm_analytics({ provider: 'Tasks', group_by: 'typeID' })",
      'It uses no filter, so nothing can be silently dropped, and one call returns every task ' +
        'type with its count. Read the CALMUS row: that is the answer.',
      'The counts are entity counts. Do not compute them yourself from analytics rows: the ' +
        "service emits one row per combination of a record's dimension values, so a single task " +
        'with several tags and workstreams can produce a hundred rows or more.',
      'Analytics providers span the whole tenant, so no project_id is needed. calm_list ' +
        "resource:'tasks' cannot answer this at all, because it requires one.",
      "For a filtered count instead: calm_analytics({ provider: 'Tasks', filter: \"typeID eq " +
        "'CALMUS'\", count_only: true }). Filter by typeID, never by type: the service drops a " +
        'filter it does not honour without erroring and then counts ALL tasks, which looks like a ' +
        'plausible answer. calmcp flags that when it can detect it, but the group_by above avoids ' +
        'the trap entirely.',
      'Never list the records and count them: a few hundred tasks are hundreds of KB and your ' +
        'client will truncate the response.',
      'The number is a daily snapshot. For a live count of one project use calm_list({ resource:' +
        " 'tasks', project_id: '<uuid>', task_type: 'CALMUS', count_only: true }), and expect the " +
        'two to differ.',
    ],
  },
  {
    question: 'How many open defects are there per project?',
    steps: [
      "calm_analytics({ provider: 'Defects', filter: \"defectStatus eq 'CIPDFCTOPEN'\", " +
        "group_by: 'projectName' })",
      'Returns { total, groups: [{ value, count }, ...] }: a few hundred bytes rather than a few ' +
        'hundred KB.',
      'Sanity-check any filtered analytics number against the same call without the filter. If ' +
        'the two totals match, the service ignored the filter rather than applying it.',
      "Swap group_by for 'priority', 'team', 'statusText' or 'assignee' to break the same set " +
        'down another way, or pass several: group_by: "projectName,priority".',
      'On the Defects provider the status dimension is `defectStatus`, not `status`. Call ' +
        "calm_resources({ topic: 'Defects' }) for the full field list.",
    ],
  },
  {
    question: 'How many user stories are open in project X, by sprint?',
    steps: [
      "calm_list({ resource: 'tasks', project_id: '<uuid>', task_type: 'CALMUS', status: " +
        "'CIPUSOPEN', group_by: 'timeboxId' })",
      'The Tasks REST API has no count of any kind, so calmcp pages through and returns only the ' +
        'tally. This is a live read, unlike the analytics snapshot.',
      'Drop group_by and pass count_only: true for the plain total.',
      "Resolve timebox ids to names with calm_list({ resource: 'project_timeboxes', project_id: " +
        "'<uuid>' }), which is a short list.",
    ],
  },
  {
    question: 'Show me all open defects ordered by priority',
    steps: [
      "calm_list({ resource: 'tasks', project_id: '<uuid>', task_type: 'CALMDEF', status: " +
        "'CIPDFCTOPEN', fields: 'displayId,title,priority,assigneeName,dueDate' })",
      'Then sort the returned records by priority yourself. Nothing in Cloud ALM sorts these for ' +
        'you: the Tasks REST endpoint has no sort parameter, and calm_analytics accepts $orderby ' +
        'but ignores it, returning unsorted rows with a 200. Never present analytics output as ' +
        'sorted.',
      'Priority codes rank 10 Very High, 20 High, 30 Medium, 40 Low, so ascending code order is ' +
        'descending urgency.',
      "For how many rather than which: calm_analytics({ provider: 'Defects', group_by: " +
        "'priority' }) counts open defects per priority tenant-wide.",
    ],
  },
  {
    question: 'Which user stories are open in Sprint 5?',
    steps: [
      "calm_list({ resource: 'tasks', project_id: '<uuid>', task_type: 'CALMUS', status: 'CIPUSOPEN', timebox_name: 'Sprint 5', fields: 'displayId,title,status,assigneeName,dueDate' })",
      'Always pass `fields` for tasks: a task has 67 attributes, so an unprojected list is hundreds of KB and overflows smaller agent hosts.',
      'Use timebox_id instead of timebox_name when you already resolved the sprint via project_timeboxes.',
    ],
  },
  {
    question: 'Show me the assigned Features for defect Y',
    steps: [
      "1) calm_list({ resource: 'task_feature_assignments', task_id: 'Y' }) -> collect each featureId",
      "2) calm_get({ resource: 'feature', id: '<featureId>' }) for each feature you need details on",
    ],
  },
];
