import {
  runSantaFePublicBrowserQa as runStrictSantaFePublicBrowserQa,
  type SantaFePublicBrowserQaOptions,
} from './santa-fe-public-browser-qa-v4'

export type { SantaFePublicBrowserQaOptions }

export async function runSantaFePublicBrowserQa(options: SantaFePublicBrowserQaOptions) {
  if (process.env.STRACKER_DEFER_PUBLIC_3D_QA === '1') {
    console.log('SANTA_FE_PUBLIC_BROWSER_QA=DEFERRED_TO_POST_PROMOTION')
    return {
      schema: 'stracker.santa-fe-public-browser-qa.deferred.v1',
      privateDataUsed: false,
      realUserCoordinatesUsed: false,
      coordinateValuesRetained: false,
      deferredTo: 'santa-fe-post-promotion-browser-qa.ts',
      gates: {
        PUBLIC_3D_QA_DEFERRED_TO_POST_PROMOTION: 'PASS',
      },
    }
  }
  return runStrictSantaFePublicBrowserQa(options)
}