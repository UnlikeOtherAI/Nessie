import { billingStatementV1ConformanceFixture } from './conformance-fixture.js';
import { billingStatementV1JsonSchema } from './schema.js';
import { BILLING_STATEMENT_PROTOCOL_VERSION } from './types.js';
export const billingStatementV1OpenApiDocument = {
    openapi: '3.1.0',
    info: {
        title: 'UOA BillingStatementV1 consumer contract',
        version: BILLING_STATEMENT_PROTOCOL_VERSION,
        description: 'OpenAPI 3.1 component and conformance fixture for the display-ready UOA customer billing statement.',
    },
    paths: {},
    components: {
        schemas: {
            BillingStatementV1: billingStatementV1JsonSchema,
        },
        examples: {
            BillingStatementV1Conformance: {
                summary: 'Display-ready BillingStatementV1 example with direct and indirect products',
                value: billingStatementV1ConformanceFixture,
            },
        },
    },
};
