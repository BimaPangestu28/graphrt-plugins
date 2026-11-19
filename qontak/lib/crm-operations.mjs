/**
 * Qontak CRM operations (contacts, companies, deals, tasks, notes, pipelines and stages), as declarative specs.
 * Paths are the same on the Mekari gateway (/qontak/crm/...) and the older app.qontak.com/api/v3.1 host; lists page
 * with page/per_page and return {meta, response}. Custom fields go in `additional_fields`
 * ([{id, name, value, value_name}]; ids from GET /<object>/info).
 *
 * Creates and updates need CRM_WRITES_OPT_IN_ENV as agent tools; deletes are node only.
 */
export const CRM_WRITES_OPT_IN_ENV = "QONTAK_TOOL_ALLOW_CRM_WRITES";

const body = (type, description) => ({ in: "body", type, ...(description ? { description } : {}) });
const additionalFields = { additional_fields: { in: "body", type: "array", items: { type: "object" }, description: 'Custom fields, e.g. [{"name": "segment", "value": "retail"}] (ids from the object\'s /info)' } };

const CRM_OBJECTS = [
  {
    singular: "contact",
    plural: "contacts",
    label: "contact (person)",
    listFilters: {
      name: { in: "query", type: "string" },
      email: { in: "query", type: "string" },
      phone: { in: "query", type: "string" },
      crm_company_id: { in: "query", type: "integer" },
      created_after: { in: "query", type: "string", description: "DD-MM-YYYY" },
    },
    requiredField: "first_name",
    fields: {
      first_name: body("string"),
      last_name: body("string"),
      job_title: body("string"),
      email: body("string"),
      telephone: body("string", "Phone with country code, e.g. 6281234567890"),
      crm_status_id: body("integer"),
      crm_company_id: body("integer"),
      crm_deal_ids: { in: "body", type: "array", items: { type: "integer" } },
      crm_source_id: body("integer"),
      address: body("string"),
      city: body("string"),
      province: body("string"),
      country: body("string"),
      zipcode: body("string"),
      date_of_birth: body("string", "YYYY-MM-DD"),
      creator_id: body("integer", "Owner user id (default: the API user)"),
    },
  },
  {
    singular: "company",
    plural: "companies",
    label: "company",
    listFilters: { name: { in: "query", type: "string" }, website: { in: "query", type: "string" } },
    requiredField: "name",
    fields: {
      name: body("string"),
      website: body("string"),
      telephone: body("string"),
      address: body("string"),
      city: body("string"),
      province: body("string"),
      country: body("string"),
      zipcode: body("string"),
      crm_person_ids: { in: "body", type: "array", items: { type: "integer" }, description: "Contact ids to link" },
      creator_id: body("integer", "Owner user id"),
    },
  },
  {
    singular: "deal",
    plural: "deals",
    label: "deal",
    listFilters: { name: { in: "query", type: "string" } },
    requiredField: "name",
    createRequired: ["crm_pipeline_id", "crm_stage_id"],
    fields: {
      name: body("string"),
      crm_pipeline_id: body("integer", "Pipeline id (list_pipelines)"),
      crm_stage_id: body("integer", "Stage id (list_pipeline_stages)"),
      currency: body("string", "e.g. IDR"),
      size: body("number", "Deal value"),
      closed_date: body("string", "YYYY-MM-DD"),
      start_date: body("string", "YYYY-MM-DD"),
      expired_date: body("string", "YYYY-MM-DD"),
      crm_company_id: body("integer"),
      crm_lead_ids: { in: "body", type: "array", items: { type: "integer" }, description: "Contact ids to link" },
      crm_source_id: body("integer"),
      crm_priority_id: body("integer"),
      crm_lost_reason_id: body("integer"),
      creator_id: body("integer", "Owner user id (default: the API user)"),
    },
  },
  {
    singular: "task",
    plural: "tasks",
    label: "task",
    listFilters: { task_name: { in: "query", type: "string" }, crm_task_status_id: { in: "query", type: "integer" } },
    requiredField: "name",
    fields: {
      name: body("string"),
      crm_person_id: body("integer", "Contact id"),
      crm_deal_id: body("integer"),
      crm_company_id: body("integer"),
      crm_task_status_id: body("integer"),
      crm_task_priority_id: body("integer"),
      crm_task_category_id: body("integer"),
      user_id: body("integer", "Assignee user id"),
      due_date: body("string", "ISO 8601, e.g. 2026-12-01T10:00:00.000+07:00"),
      reminder_date: body("string", "ISO 8601"),
      detail: body("string"),
      next_step: body("string"),
    },
  },
  {
    singular: "note",
    plural: "notes",
    label: "note",
    listFilters: { crm_lead_id: { in: "query", type: "integer", description: "Contact id" }, crm_company_id: { in: "query", type: "integer" }, crm_deal_id: { in: "query", type: "integer" } },
    requiredField: "note",
    fields: {
      note: body("string"),
      note_type: { in: "body", type: "string", wireName: "type", description: 'Note owner type, e.g. "Crm::PersonNote"' },
      crm_person_id: body("integer", "Contact id"),
      crm_deal_id: body("integer"),
      crm_company_id: body("integer"),
      creator_id: body("integer"),
    },
    noAdditionalFields: true,
  },
];

const PAGE = { dataPath: "response", pagePagination: { pageParam: "page", sizeParam: "per_page" }, maxLimit: 100, defaultLimit: 25 };

function createFields(crmObject, isCreate) {
  const fields = { ...crmObject.fields, ...(crmObject.noAdditionalFields ? {} : additionalFields) };
  if (!isCreate) return fields;
  const required = [crmObject.requiredField, ...(crmObject.createRequired ?? [])];
  return Object.fromEntries(Object.entries(fields).map(([fieldName, spec]) => [fieldName, required.includes(fieldName) ? { ...spec, required: true } : spec]));
}

function objectOperations(crmObject, baseUrl) {
  const { singular, plural, label } = crmObject;
  const idParamName = `${singular}_id`;
  const idParam = { [idParamName]: { in: "path", type: "integer", required: true, min: 1, description: `${label} id` } };
  const itemPath = `/${plural}/{${idParamName}}`;
  const writePolicy = `optIn:${CRM_WRITES_OPT_IN_ENV}`;
  return [
    { name: `list_${plural}`, title: `List ${plural}`, description: `CRM ${plural}, newest first`, baseUrl, path: `/${plural}`, params: crmObject.listFilters, response: PAGE },
    { name: `get_${singular}`, title: `Get ${singular}`, description: `One CRM ${label}`, baseUrl, path: itemPath, params: idParam, response: { dataPath: "response" } },
    { name: `create_${singular}`, title: `Create ${singular}`, description: `Create a CRM ${label}`, baseUrl, method: "POST", path: `/${plural}`, write: "unsafe", toolPolicy: writePolicy, checkHint: `list_${plural} for the new ${label}`, params: createFields(crmObject, true), response: { dataPath: "response" } },
    { name: `update_${singular}`, title: `Update ${singular}`, description: `Change fields of a CRM ${label}`, baseUrl, method: "PUT", path: itemPath, write: "idempotent", toolPolicy: writePolicy, params: { ...idParam, ...createFields(crmObject, false) }, response: { dataPath: "response" } },
    { name: `delete_${singular}`, title: `Delete ${singular}`, description: `Delete a CRM ${label}`, baseUrl, method: "DELETE", path: itemPath, write: "unsafe", nodeOnly: true, checkHint: `get_${singular}`, params: idParam },
  ];
}

function pipelineOperations(baseUrl) {
  const pipelineId = { pipeline_id: { in: "path", type: "integer", required: true, min: 1 } };
  return [
    { name: "list_pipelines", title: "List pipelines", description: "Deal pipelines", baseUrl, path: "/pipelines", response: { dataPath: "response" } },
    { name: "get_pipeline", title: "Get pipeline", description: "One deal pipeline", baseUrl, path: "/pipelines/{pipeline_id}", params: pipelineId, response: { dataPath: "response" } },
    { name: "list_pipeline_stages", title: "Pipeline stages", description: "Stages of a pipeline (crm_stage_id for deals)", baseUrl, path: "/pipelines/{pipeline_id}/stages", params: pipelineId, response: { dataPath: "response" } },
  ];
}

/**
 * Every CRM operation spec.
 *
 * @param baseUrl - CRM base URL or `(environment) => url` (string | function)
 * @returns Operation specs (object[])
 */
export function crmOperations(baseUrl) {
  return [...CRM_OBJECTS.flatMap((crmObject) => objectOperations(crmObject, baseUrl)), ...pipelineOperations(baseUrl)];
}
