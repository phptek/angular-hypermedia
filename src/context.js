'use strict';

angular.module('hypermedia')

  /**
   * @ngdoc type
   * @name ResourceContext
   * @description
   *
   * Context for working with hypermedia resources. The context has methods
   * for making HTTP requests and acts as an identity map.
   */
  .factory('ResourceContext', ['$http', '$log', '$q', 'Resource', 'HypermediaUtil', function ($http, $log, $q, Resource, HypermediaUtil) {

    var busyRequests = 0;
    var errorHandlers = {};

    /**
     * Resource context.
     *
     * @constructor
     * @param {ResourceFactory} [resourceFactory]
     */
    function ResourceContext(resourceFactory) {
      this.resourceFactory = resourceFactory || ResourceContext.defaultResourceFactory;
      this.resources = {};
    }

    Object.defineProperties(ResourceContext, {

      /**
       * The default resource factory.
       *
       * @property {resourceFactory}
       */
      defaultResourceFactory: {value: Resource, writable: true},

      /**
       * The number of current HTTP requests.
       *
       * @property {number}
       */
      busyRequests: {get: function () {
        return busyRequests;
      }},

      registerErrorHandler: {value: function (contentType, handler) {
        errorHandlers[contentType] = handler;
      }},

      /**
       * Whether resource aliases are allowed by default.
       */
      defaultEnableAliases: {value: true, writable: true}
    });

    ResourceContext.prototype = Object.create(Object.prototype, {
      constructor: {value: ResourceContext}
    });

    HypermediaUtil.defineProperties(ResourceContext.prototype, {
      /**
       * Get the resource for an URI. Creates a new resource if not already in the context.
       *
       * @function
       * @param {string} uri
       * @param {ResourceFactory} [Factory] optional resource creation function
       * @returns {Resource}
       */
      get: {value: function (uri, Factory) {
        var resource = this.resources[uri];
        if (!resource) {
          Factory = (Factory || this.resourceFactory);
          if (!Factory) throw new Error('No resource factory: ' + uri);
          resource = this.resources[uri] = new Factory(uri, this);
        }
        return resource;
      }},

      /**
       * Copy a resource into this context.
       *
       * @function
       * @param {Resource} resource
       * @returns {Resource} a copy of the resource in this context
       */
      copy: {value: function (resource) {
        var copy = this.get(resource.$uri);
        copy.$update(resource, resource.$links);
        return copy;
      }},

      /**
       * Whether resaurce aliases are enabled. If false, context.addAlias throws an error.
       */
      enableAliases: {value: ResourceContext.defaultEnableAliases, writable: true},

      /**
       * Adds an alias to an existing resource.
       *
       * @function
       * @param {string} aliasUri the new URI to point to the original resource
       * @param {string} originalUri the URI of the original resource.
       */
      addAlias: {value: function (aliasUri, originalUri) {
        if (!this.enableAliases) throw new Error('Resource aliases not enabled');
        this.resources[aliasUri] = this.resources[originalUri];
      }},

      /**
       * Perform a HTTP GET request on a resource.
       *
       * @function
       * @param {Resource} resource
       * @returns a promise that is resolved to the resource
       * @see Resource#$getRequest
       */
      httpGet: {value: function (resource) {
        var self = this;
        busyRequests += 1;
        var request = updateHttp(resource.$getRequest());
        return $http(request).then(function (response) {
          var links = parseLinkHeader(response.headers('Link'));

          // Convert media type profile to profile link
          var mediaType = mediaTypeParser.parse(response.headers('Content-Type'));
          if (!('profile' in links) && 'profile' in mediaType.params) {
            links.profile = {href: mediaType.params.profile};
          }

          var updatedResources = resource.$update(response.data, links);
          return self.markSynced(updatedResources, Date.now());
        }, handleErrorResponse).then(function () {
          return resource;
        }).finally(function () {
          busyRequests -= 1;
        });
      }},

      /**
       * Perform a HTTP PUT request.
       *
       * @function
       * @param {Resource} resource
       * @returns a promise that is resolved to the resource
       * @see Resource#$putRequest
       */
      httpPut: {value: function (resource) {
        var self = this;
        busyRequests += 1;
        var request = updateHttp(resource.$putRequest());
        return $http(request).then(function () {
          return self.markSynced(resource, Date.now());
        }, handleErrorResponse).then(function () {
          return resource;
        }).finally(function () {
          busyRequests -= 1;
        });
      }},

      /**
       * Perform a HTTP PATCH request.
       *
       * @function
       * @param {Resource} resource
       * @returns a promise that is resolved to the resource
       * @see Resource#$patchRequest
       */
      httpPatch: {value: function (resource, data) {
        var self = this;
        busyRequests += 1;
        var request = updateHttp(resource.$patchRequest(data));
        return $http(request).then(function () {
          resource.$merge(request.data);
          return self.markSynced(resource, Date.now());
        }, handleErrorResponse).then(function () {
          return resource;
        }).finally(function () {
          busyRequests -= 1;
        });
      }},

      /**
       * Perform a HTTP DELETE request and unmark the resource as synchronized.
       *
       * @function
       * @param {Resource} resource
       * @returns a promise that is resolved to the resource
       * @see Resource#$deleteRequest
       */
      httpDelete: {value: function (resource) {
        var self = this;
        busyRequests += 1;
        var request = updateHttp(resource.$deleteRequest());
        return $http(request).then(function () {
          delete self.resources[resource.$uri];
          return self.markSynced(resource, null);
        }, handleErrorResponse).then(function () {
          return resource;
        }).finally(function () {
          busyRequests -= 1;
        });
      }},

      /**
       * Perform a HTTP POST request.
       *
       * @function
       * @param {Resource} resource
       * @param {*} data request body
       * @param {object} [headers] request headers
       * @param {ConfigHttp} [callback] a function that changes the $http request config
       * @returns a promise that is resolved to the response
       * @see Resource#$postRequest
       */
      httpPost: {value: function (resource, data, headers, callback) {
        busyRequests += 1;
        var request = updateHttp(resource.$postRequest(data, headers, callback));
        return $http(request).catch(handleErrorResponse).finally(function () {
          busyRequests -= 1;
        });
      }},

      /**
       * Mark a resource as synchronized with the server.
       *
       * @function
       * @param {Resource|Resource[]} resources
       * @param {number} syncTime the timestamp of the last synchronization
       * @returns a promise that is resolved when the resources have been marked
       * @see Resource#syncTime
       */
      markSynced: {value: function (resources, syncTime) {
        resources = angular.isArray(resources) ? resources : [resources];
        resources.forEach(function (resource) {
          resource.$syncTime = syncTime;
        });
        return $q.when();
      }}
    });

    return ResourceContext;


    function appendTransform(defaults, transform) {
      if (!transform) return defaults;
      defaults = angular.isArray(defaults) ? defaults : [defaults];
      return defaults.concat(transform);
    }

    function updateHttp(config) {
      config.transformRequest = appendTransform($http.defaults.transformRequest, config.addTransformRequest);
      config.transformResponse = appendTransform($http.defaults.transformResponse, config.addTransformResponse);
      return config;
    }

    function parseLinkHeader(header) {
      return header ? linkHeaderParser.parse(header) : {};
    }

    function handleErrorResponse(response) {
      var contentType = response.headers('Content-Type');
      var handler = errorHandlers[contentType];
      response.error = (handler ? handler(response) : {message: response.statusText});
      return $q.reject(response);
    }
  }])

;

/**
 * A callback function used by the context to create resources. Will be called
 * with the 'new' operator, so can be a constructor.
 *
 * @callback ResourceFactory
 * @returns {Resource} the created resource
 * @see ResourceContext
 */
