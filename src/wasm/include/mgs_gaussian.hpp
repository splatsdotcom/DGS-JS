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

	std::vector<vec3> means;
	std::vector<vec3> scales;
	std::vector<quaternion> rotations;
	std::vector<float> opacities;
	std::vector<vec3> colors;
	std::vector<vec3> shs;

	Gaussians(uint32_t shDegree = 0);

	void add(const vec3& mean, const vec3& scale, const quaternion& rotation, 
	         float opacity, const vec3& color, const std::vector<vec3>& sh);
};

/**
 * a list of gaussians, packed and processed
 */
struct GaussiansPacked
{
	uint32_t shDegree = 0;
	uint32_t count = 0;

	float colorMax = -0.5f;
	float colorMin =  0.5f;
	float shMax    = -0.5f;
	float shMin    =  0.5f;

	std::vector<vec4> means;        // stored as vec4 to respect GPU alignment rules, TODO fix this
	std::vector<float> covariances;
	std::vector<uint8_t> opacities; // unorm8  [0.0, 1.0]
	std::vector<uint16_t> colors;   // unorm16 [colorMin, colorMax]
	std::vector<uint8_t> shs;       // unorm8  [shMin, shMax]

	GaussiansPacked(const Gaussians& gaussians);
	GaussiansPacked(const std::vector<uint8_t>& serialized);

	std::vector<uint8_t> serialize() const;
};

}; //namespace mgs

#endif //#ifndef MGS_GAUSSIAN_HPP
