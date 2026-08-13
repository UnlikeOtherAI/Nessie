import { nullableDateTimeSchema } from './funding-schema-primitives.js';
const subscriptionBaseProperties = {
    status: { type: 'string' },
    display_status: { type: 'string' },
    scope: { enum: ['organisation', 'team', 'subscribing_user'] },
    cancel_at_period_end: { type: 'boolean' },
    current_period_start: nullableDateTimeSchema,
    current_period_end: nullableDateTimeSchema,
};
const subscriptionBaseRequired = [
    'status',
    'display_status',
    'scope',
    'cancel_at_period_end',
    'current_period_start',
    'current_period_end',
];
export const billingRecurringAddonManagerSubscriptionJsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: [...subscriptionBaseRequired, 'id', 'owner_user_id'],
    properties: {
        ...subscriptionBaseProperties,
        id: { type: 'string', minLength: 1 },
        owner_user_id: { type: ['string', 'null'], minLength: 1 },
    },
};
export const billingRecurringAddonMemberSubscriptionJsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: [...subscriptionBaseRequired, 'owner_relationship'],
    properties: {
        ...subscriptionBaseProperties,
        owner_relationship: {
            enum: ['organisation', 'team', 'viewer', 'other_team_member'],
        },
    },
};
const viewerSchema = (role, entitlementVisibility) => ({
    type: 'object',
    additionalProperties: false,
    required: ['role', 'entitlement_visibility', 'description'],
    properties: {
        role: { const: role },
        entitlement_visibility: { const: entitlementVisibility },
        description: { type: 'string' },
    },
});
const offerVisibilitySchema = (subscriptionSchema, memberProjection) => ({
    type: 'array',
    items: {
        type: 'object',
        required: ['subscription', 'actions'],
        properties: {
            subscription: { oneOf: [subscriptionSchema, { type: 'null' }] },
            actions: {
                type: 'array',
                ...(memberProjection ? { maxItems: 0 } : { items: { type: 'object' } }),
            },
        },
    },
});
export const billingRecurringAddonVisibilityDiscriminatorJsonSchema = {
    oneOf: [
        {
            type: 'object',
            properties: {
                viewer: viewerSchema('billing_manager', 'full_team'),
                capabilities: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['can_manage_addons'],
                    properties: { can_manage_addons: { type: 'boolean' } },
                },
                offers: offerVisibilitySchema(billingRecurringAddonManagerSubscriptionJsonSchema, false),
            },
        },
        {
            type: 'object',
            properties: {
                viewer: viewerSchema('member', 'own_plus_team_status'),
                capabilities: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['can_manage_addons'],
                    properties: { can_manage_addons: { const: false } },
                },
                offers: offerVisibilitySchema(billingRecurringAddonMemberSubscriptionJsonSchema, true),
            },
        },
    ],
};
