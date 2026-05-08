# @usehercules/auth

## 1.0.44

### Patch Changes

- [#24](https://github.com/withzeusai/hercules-js/pull/24) [`3c01de3`](https://github.com/withzeusai/hercules-js/commit/3c01de3f1f3c075362abc5e8e8dc45a710b4baf5) Thanks [@grant0417](https://github.com/grant0417)! - Fix Convex provider reporting `isLoading` as `true` when `isAuthenticated` is already `true`, preventing unnecessary loading states. Skip token refresh when the current token won't expire within the next hour.

## 1.0.43

### Patch Changes

- [#20](https://github.com/withzeusai/hercules-js/pull/20) [`1b71f08`](https://github.com/withzeusai/hercules-js/commit/1b71f08fbc22204fed07475fa35a672accbed1bc) Thanks [@delbyte](https://github.com/delbyte)! - Re-enable forced token refresh in `ConvexProviderWithHerculesAuth` so Convex
  can recover after a 401 instead of getting the same expired id token back.
  Concurrent refresh requests share a single in-flight `signinSilent` call to
  avoid the React 19 strict-mode duplicate-refresh race that motivated the
  original disable.

## 1.0.42

### Patch Changes

- [#17](https://github.com/withzeusai/hercules-js/pull/17) [`8c4f95f`](https://github.com/withzeusai/hercules-js/commit/8c4f95ff1fde1c98a855b16b8653af3bb35f086b) Thanks [@grant0417](https://github.com/grant0417)! - Add `signin` method to `useAuth` hook that wraps `signinRedirect` in a stable callback

## 1.0.41

### Patch Changes

- [#14](https://github.com/withzeusai/hercules-js/pull/14) [`5efd2ba`](https://github.com/withzeusai/hercules-js/commit/5efd2bacb54710376c585f4362c0e7988e8bf7fb) Thanks [@grant0417](https://github.com/grant0417)! - Add changesets for package versioning and publishing
