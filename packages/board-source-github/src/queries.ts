/** The GraphQL Projects v2 needs; there is no REST equivalent for any of it. */

export const VIEWER_PROJECTS_QUERY = `
  query ViewerProjects {
    viewer {
      projectsV2(first: 50) { nodes { id number title } }
    }
  }
`

export const PROJECT_STATUS_QUERY = `
  query ProjectStatus($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        field(name: "Status") {
          ... on ProjectV2SingleSelectField { options { id name } }
        }
        fields(first: 30) {
          nodes {
            ... on ProjectV2Field { name dataType }
            ... on ProjectV2SingleSelectField { name dataType }
          }
        }
      }
    }
  }
`

export const PROJECT_ITEMS_QUERY = `
  query ProjectItems($projectId: ID!, $after: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100, after: $after) {
          nodes {
            id
            updatedAt
            isArchived
            content {
              __typename
              ... on Issue {
                id number title body url createdAt updatedAt
                assignees(first: 1) { nodes { id login } }
              }
              ... on DraftIssue { id title body createdAt updatedAt }
            }
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name optionId field { ... on ProjectV2SingleSelectField { name } }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text field { ... on ProjectV2Field { name } }
                }
                ... on ProjectV2ItemFieldNumberValue {
                  number field { ... on ProjectV2Field { name } }
                }
                ... on ProjectV2ItemFieldDateValue {
                  date field { ... on ProjectV2Field { name } }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`
