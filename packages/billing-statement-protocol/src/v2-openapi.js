import { billingStatementV2ConformanceFixture } from './v2-conformance-fixture.js';
import { billingStatementV2JsonSchema } from './v2-schema.js';
import { BILLING_STATEMENT_V2_PROTOCOL_VERSION } from './v2-types.js';
export const billingStatementV2OpenApiDocument = {
    openapi: '3.1.0',
    info: {
        title: 'UOA BillingStatementV2 consumer contract',
        version: BILLING_STATEMENT_V2_PROTOCOL_VERSION,
        description: 'OpenAPI 3.1 component and conformance fixture for the SSO-filled customer statement and team-wide connected-service usage portfolio.',
    },
    paths: {},
    components: {
        schemas: {
            BillingStatementV2: billingStatementV2JsonSchema,
        },
        examples: {
            BillingStatementV2Conformance: {
                summary: 'Display-ready BillingStatementV2 example with team, origin-product, and user usage transparency',
                value: billingStatementV2ConformanceFixture,
            },
        },
    },
};
