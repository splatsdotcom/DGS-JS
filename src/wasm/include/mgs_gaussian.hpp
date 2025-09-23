/* mgs_gaussian.hpp
 *
 * contains the definition for the basic gaussian type
 */

#ifndef MGS_GAUSSIAN_HPP
#define MGS_GAUSSIAN_HPP

#include <array>
#include <vector>
#include <thread>
#include <atomic>
#include <vector>
#include <memory>
#include <mutex>
#include <optional>

#include "quickmath.hpp"
using namespace qm;

#define MGS_NUM_SPHERICAL_HARMONIC 1

namespace mgs
{

//-------------------------------------------//

class Gaussian;
class GaussianPacked;

/**
 * all parameters describing a 3D gaussian with spherical harmonics, uncompressed
 */
class Gaussian
{
public:
	Gaussian(const vec3& pos, const vec3& scale, const quaternion& orient, const std::array<vec4, MGS_NUM_SPHERICAL_HARMONIC>& harmonics);

	GaussianPacked pack();

	vec3 pos;
	vec3 scale;
	quaternion orient;

	std::array<vec4, MGS_NUM_SPHERICAL_HARMONIC> harmonics;
};

/**
 * all parameters describing a 3D gaussian with spherical harmonics, compressed for rendering
 */
class GaussianPacked
{
public:
	Gaussian unpack();

	uint32_t covariance[3];
	std::array<uint32_t, MGS_NUM_SPHERICAL_HARMONIC> harmonics;
	vec3 pos;

	uint32_t padding;
};

/**
 * a group of gaussians
 */
class GaussianGroup
{
public:
	GaussianGroup(const std::vector<GaussianPacked>& gaussians);
	// GaussianGroup(const std::vector<Gaussian>& gaussians);

	uint32_t count() const;
	const std::vector<GaussianPacked>& data() const;

	std::vector<uint32_t> sorted_indices(const vec3& camPos);

	void sort_indices_async(const vec3& camPos);
	std::optional<std::vector<uint32_t>> sort_indices_async_retrieve();

private:
	std::vector<GaussianPacked> m_gaussians;

	//async stuff TODO refactor this
    std::vector<uint32_t> m_sortedIndices;
    std::atomic<bool> m_sortInProgress{false};
    std::atomic<bool> m_sortDone{false};
    mutable std::mutex m_sortMutex;
    std::thread m_thread;
};

}; //namespace mgs

#endif //#ifndef MGS_GAUSSIAN_HPP
