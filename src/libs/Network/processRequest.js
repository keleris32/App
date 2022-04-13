import lodashGet from 'lodash/get';
import CONST from '../../CONST';
import HttpUtils from '../HttpUtils';
import enhanceParameters from './enhanceParameters';
import * as NetworkEvents from './NetworkEvents';
import * as PersistedRequests from '../actions/PersistedRequests';
import _ from 'underscore';

/**
 * @param {Object} request
 * @param {Object} parameters
 */
function logRequestDetails(request, parameters) {
    // Don't log about log or else we'd cause an infinite loop
    if (request.command === 'Log') {
        return;
    }

    NetworkEvents.getLogger().info('Making API request', false, {
        command: request.command,
        type: request.type,
        shouldUseSecure: request.shouldUseSecure,
        rvl: parameters.returnValueList,
    });
}

/**
 * @param {Object} request
 * @param {String} request.command
 * @param {Object} request.data
 * @param {String} request.type
 * @param {Boolean} request.shouldUseSecure
 * @returns {Promise}
 */
export default function processRequest(request) {
    const persisted = lodashGet(request, 'data.persist', false);
    const finalParameters = enhanceParameters(request.command, request.data);

    // When the request goes past a certain amount of time we trigger a re-check of the connection
    const cancelRequestTimeoutTimer = NetworkEvents.startRecheckTimeoutTimer();
    logRequestDetails(request, finalParameters);
    return HttpUtils.xhr(request.command, finalParameters, request.type, request.shouldUseSecure)
        .then((response) => {
            if (persisted) {
                PersistedRequests.remove(request);
            }
            NetworkEvents.triggerResponse(request, response);
            return response;
        })
        .catch((error) => {
            if (error.message === CONST.ERROR.FAILED_TO_FETCH) {
                NetworkEvents.getLogger().hmmm(`[Network] Error: ${CONST.ERROR.FAILED_TO_FETCH}`);

                // Throw when we get a "Failed to fetch" error so we can retry. Very common if a user is offline or experiencing an unlikely scenario like
                // incorrect url, bad cors headers returned by the server, DNS lookup failure etc.
                throw error;
            }

            // These errors seem to happen for native devices with interrupted connections. Often we will see logs about Pusher disconnecting together with these.
            // In browsers this type of failure would throw a "Failed to fetch" so we can treat these the same. This type of error may also indicate a problem with
            // SSL certs.
            if (_.contains([CONST.ERROR.IOS_NETWORK_CONNECTION_LOST, CONST.ERROR.NETWORK_REQUEST_FAILED], error.message)) {
                NetworkEvents.getLogger().hmmm('[Network] Connection interruption likely', {error: error.message});
                throw new TypeError(CONST.ERROR.FAILED_TO_FETCH);
            }

            // This message can be observed page load is interrupted (closed or navigated away). Chrome throws a generic "Failed to fetch" error so we will standardize and throw this.
            if (_.contains([CONST.ERROR.FIREFOX_DOCUMENT_LOAD_ABORTED, CONST.ERROR.SAFARI_DOCUMENT_LOAD_ABORTED], error.message)) {
                NetworkEvents.getLogger().hmmm('[Network] User likely navigated away from or closed browser', {error: error.message});
                throw new TypeError(CONST.ERROR.FAILED_TO_FETCH);
            }

            // Not yet clear why this message occurs, but it is specific to iOS and tends to happen around the same time as a Pusher code 1006
            // so it seems likely to be a spotty connection scenario.
            if (error.message === CONST.ERROR.IOS_LOAD_FAILED) {
                throw new TypeError(CONST.ERROR.FAILED_TO_FETCH);
            }

            // Cancelled requests are normal and can happen when a user logs out. No extra handling is needed here besides
            // remove the request from the PersistedRequests if the request exists.
            if (error.name === CONST.ERROR.REQUEST_CANCELLED) {
                NetworkEvents.getLogger().info('[Network] Request canceled', false, request);
            } else {
                // If we get any error that is not "Failed to fetch" create GitHub issue so we can handle it. These requests will not be retried.
                NetworkEvents.getLogger().alert(`${CONST.ERROR.ENSURE_BUGBOT} unknown error caught while processing request`, {
                    command: request.command,
                    error: error.message,
                });
            }

            // If we did not throw and we have a persisted request that was cancelled or for an unknown error remove it so it is not retried
            if (persisted) {
                PersistedRequests.remove(request);
            }
        })
        .finally(() => cancelRequestTimeoutTimer());
}
