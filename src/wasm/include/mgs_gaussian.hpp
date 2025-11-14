/* mgs_gaussian.hpp
 *
 * contains the definition for the basic gaussian type
 */

#ifndef MGS_GAUSSIAN_HPP
#define MGS_GAUSSIAN_HPP

#include <vector>
#include <memory>
#include <pthread.h>

#include "quickmath.hpp"
using namespace qm;

#define MGS_MAX_SH_DEGREE 3

namespace mgs
{

//-------------------------------------------//

/**
 * a list of gaussians
 */
struct Gaussians
{
	uint32_t shDegree = 0;
	uint32_t count = 0;
	bool dynamic = false;

	std::vector<vec3> means;
	std::vector<vec3> scales;
	std::vector<quaternion> rotations;
	std::vector<float> opacities;
	std::vector<vec3> colors;
	std::vector<vec3> shs;

	std::vector<vec3> velocities;
	std::vector<float> tMeans;
	std::vector<float> tStdevs;

	Gaussians(uint32_t shDegree = 0, bool dynamic = false);

	void add(const vec3& mean, const vec3& scale, const quaternion& rotation, 
	         float opacity, const vec3& color, const std::vector<vec3>& sh = {},
	         const vec3& velocity = vec3(0.0f), float tMean = 0.0f, float tStdev = 0.0f);
};

/**
 * a list of gaussians, packed and processed
 */
struct GaussiansPacked
{
	uint32_t shDegree = 0;
	uint32_t count = 0;
	bool dynamic = false;

	float colorMax = -0.5f;
	float colorMin =  0.5f;
	float shMax    = -0.5f;
	float shMin    =  0.5f;

	std::vector<vec4> means;        // packed xyz mean and t mean
	std::vector<vec4> velocities;   // packed xyz velocity and t stdev
	std::vector<float> covariances;
	std::vector<uint8_t> opacities; // unorm8  [0.0, 1.0]
	std::vector<uint16_t> colors;   // unorm16 [colorMin, colorMax]
	std::vector<uint8_t> shs;       // unorm8  [shMin, shMax]

	GaussiansPacked(const Gaussians& gaussians);
	GaussiansPacked(const std::vector<uint8_t>& serialized);

	std::vector<uint8_t> serialize() const;
};

/**
 * performs culling and sorting on gaussians
 */
class GaussianSorter
{
public:
	GaussianSorter(const std::shared_ptr<GaussiansPacked>& gaussians);

	void sort(const mat4& view, const mat4& proj, float time, bool isAsync = false);
	
	void sort_async_start(const mat4& view, const mat4& proj, float time);
	bool sort_async_pending() const;
	bool sort_async_tryjoin();

	const std::vector<uint32_t>& get_latest() const;

private:
	std::shared_ptr<GaussiansPacked> m_gaussians;

	std::vector<float> m_depths;
	std::vector<uint32_t> m_indices;

	struct AsyncThreadData
	{
		bool active = false;
		pthread_t thread;

		mat4 view;
		mat4 proj;
		float time;

		GaussianSorter* sorter;
	} m_asyncThreadData;

	static void* start_async_thread(void* arg);
};

}; //namespace mgs

#endif //#ifndef MGS_GAUSSIAN_HPP
